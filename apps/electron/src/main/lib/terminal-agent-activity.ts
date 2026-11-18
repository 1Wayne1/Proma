import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execute = promisify(execFile)

export function parseTerminalProcessParents(output: string): Set<number> {
  const parents = new Set<number>()
  for (const line of output.split(/\r?\n/)) {
    const row = /^\s*(\d+)[\s,]+(\d+)\s*$/.exec(line)
    if (!row) continue
    const pid = Number(row[1])
    const ppid = Number(row[2])
    if (pid > 0 && ppid > 0 && pid !== ppid) parents.add(ppid)
  }
  return parents
}

/** 只探测 PTY 外部子进程，避免把空闲 shell 当作运行中的 Agent 命令。 */
export async function readTerminalProcessParents(signal: AbortSignal): Promise<Set<number>> {
  const options = { signal, timeout: 4_000, maxBuffer: 2 * 1024 * 1024, windowsHide: true } as const
  if (process.platform === 'win32') {
    const root = process.env.SystemRoot ?? 'C:\\Windows'
    const powershell = join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    const { stdout } = await execute(powershell, [
      '-NoProfile', '-NonInteractive', '-Command',
      'Get-CimInstance Win32_Process | ForEach-Object { "{0},{1}" -f $_.ProcessId,$_.ParentProcessId }',
    ], options)
    return parseTerminalProcessParents(stdout)
  }
  const { stdout } = await execute('/bin/ps', ['-axo', 'pid=,ppid='], options)
  return parseTerminalProcessParents(stdout)
}
