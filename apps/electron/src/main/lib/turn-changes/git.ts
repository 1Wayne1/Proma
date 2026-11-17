import { spawn } from 'node:child_process'
import type { TurnChangeLimitation, TurnChangeLimits } from '@proma/shared'
import { normalizeTurnPath } from './paths'

interface GitReadResult { code: number | null; output: Buffer; limitation?: TurnChangeLimitation }
export interface TurnGitInventory { mode: 'git-observed' | 'controlled-only'; paths: string[]; limitations: TurnChangeLimitation[] }

/** 只读 Git 命令；独立限额与取消，不改变 index，不启用外部 fsmonitor。 */
function readGit(cwd: string, args: string[], limits: TurnChangeLimits, signal?: AbortSignal): Promise<GitReadResult> {
  signal?.throwIfAborted()
  return new Promise((resolve, reject) => {
    const env = { ...process.env }
    for (const key of Object.keys(env)) if (key.toUpperCase().startsWith('GIT_')) delete env[key]
    env.GIT_TERMINAL_PROMPT = '0'
    env.GIT_OPTIONAL_LOCKS = '0'
    const child = spawn('git', ['-c', 'core.fsmonitor=false', ...args], { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
    const chunks: Buffer[] = []
    let bytes = 0
    let limitation: TurnChangeLimitation | undefined
    let settled = false
    const abort = (): void => { child.kill() }
    const timer = setTimeout(() => { limitation = 'git-timeout'; child.kill() }, limits.gitTimeoutMs)
    const finish = (code: number | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      if (signal?.aborted) reject(signal.reason)
      else resolve({ code, output: Buffer.concat(chunks), limitation })
    }
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length
      if (bytes > limits.maxGitOutputBytes) { limitation = 'git-output-limit'; child.kill(); return }
      chunks.push(chunk)
    })
    child.once('error', () => { limitation = 'git-unavailable'; finish(null) })
    child.once('close', finish)
  })
}

export async function discoverTurnGitFiles(cwd: string, limits: TurnChangeLimits, signal?: AbortSignal): Promise<TurnGitInventory> {
  const check = await readGit(cwd, ['rev-parse', '--is-inside-work-tree'], limits, signal)
  if (check.code !== 0 || check.output.toString('utf8').trim() !== 'true') return { mode: 'controlled-only', paths: [], limitations: check.limitation ? [check.limitation] : [] }
  const listed = await readGit(cwd, ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', '.'], limits, signal)
  const limitations: TurnChangeLimitation[] = listed.limitation ? [listed.limitation] : []
  if (listed.code !== 0 && !listed.limitation) limitations.push('git-unavailable')
  let names: string[]
  try { names = new TextDecoder('utf-8', { fatal: true }).decode(listed.output).split('\0').slice(0, -1) } catch { return { mode: 'git-observed', paths: [], limitations: ['git-invalid-path'] } }
  const paths = new Set<string>()
  for (const name of names) {
    try { paths.add(normalizeTurnPath(name)) } catch { if (!limitations.includes('git-invalid-path')) limitations.push('git-invalid-path') }
    if (paths.size >= limits.maxFiles) { if (names.length > paths.size) limitations.push('file-limit'); break }
  }
  return { mode: 'git-observed', paths: [...paths], limitations }
}
