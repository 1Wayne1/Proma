import { constants } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import type { TurnChangeLimits, TurnChangeLimitation, TurnFileSnapshot } from '@proma/shared'
import { assertTurnTarget, isMissingTurnFile, normalizeTurnPath } from './paths'

export const DEFAULT_TURN_CHANGE_LIMITS: Readonly<TurnChangeLimits> = Object.freeze({
  maxFiles: 500, maxFileBytes: 1024 * 1024, maxSnapshotBytes: 16 * 1024 * 1024,
  maxGitOutputBytes: 1024 * 1024, gitTimeoutMs: 5000,
})

export interface CapturedTurnFile {
  snapshot: TurnFileSnapshot
  bytes?: Buffer
}

export interface TurnCaptureBudget { remainingBytes: number }

export function validateTurnLimits(input: Partial<TurnChangeLimits> = {}): TurnChangeLimits {
  const limits = { ...DEFAULT_TURN_CHANGE_LIMITS, ...input }
  const caps: TurnChangeLimits = { maxFiles: 2000, maxFileBytes: 16 * 1024 * 1024, maxSnapshotBytes: 64 * 1024 * 1024, maxGitOutputBytes: 4 * 1024 * 1024, gitTimeoutMs: 30_000 }
  for (const key of Object.keys(caps) as Array<keyof TurnChangeLimits>) {
    if (!Number.isSafeInteger(limits[key]) || limits[key] < 1 || limits[key] > caps[key]) throw new Error(`无效的逐轮捕获限额: ${key}`)
  }
  return limits
}

function omitted(reason: NonNullable<TurnFileSnapshot['reason']>, byteLength?: number): CapturedTurnFile {
  return { snapshot: { availability: 'omitted', reason, ...(byteLength === undefined ? {} : { byteLength }) } }
}

export async function captureTurnFile(root: string, path: string, limits: TurnChangeLimits, budget: TurnCaptureBudget, signal?: AbortSignal): Promise<CapturedTurnFile> {
  signal?.throwIfAborted()
  normalizeTurnPath(path)
  let target: string
  try { target = await assertTurnTarget(root, path) } catch { return omitted('unsafe-path') }
  signal?.throwIfAborted()
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    const before = await lstat(target)
    if (before.isSymbolicLink()) return omitted('unsafe-path')
    if (!before.isFile()) return omitted('not-file')
    if (before.size > limits.maxFileBytes) return omitted('too-large', before.size)
    if (before.size > budget.remainingBytes) return omitted('budget-exceeded', before.size)
    handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    const opened = await handle.stat()
    if (!opened.isFile() || before.dev !== opened.dev || before.ino !== opened.ino) return omitted('changed-during-read')
    const capacity = Math.min(limits.maxFileBytes, budget.remainingBytes)
    const bytes = Buffer.alloc(Math.min(capacity + 1, opened.size + 1))
    let offset = 0
    while (offset < bytes.length) {
      signal?.throwIfAborted()
      const result = await handle.read(bytes, offset, bytes.length - offset, offset)
      if (!result.bytesRead) break
      offset += result.bytesRead
    }
    signal?.throwIfAborted()
    const after = await handle.stat()
    if (after.size > limits.maxFileBytes) return omitted('too-large', after.size)
    if (after.size > budget.remainingBytes) return omitted('budget-exceeded', after.size)
    if (opened.size !== after.size || opened.mtimeMs !== after.mtimeMs || offset !== after.size) return omitted('changed-during-read')
    await assertTurnTarget(root, path)
    const current = await lstat(target)
    if (current.isSymbolicLink() || current.dev !== after.dev || current.ino !== after.ino || current.size !== after.size || current.mtimeMs !== after.mtimeMs) return omitted('changed-during-read')
    const content = bytes.subarray(0, offset)
    let format: 'text' | 'binary' = 'text'
    try { if (content.includes(0)) format = 'binary'; else new TextDecoder('utf-8', { fatal: true }).decode(content) } catch { format = 'binary' }
    budget.remainingBytes -= content.length
    return { snapshot: { availability: 'available', hash: createHash('sha256').update(content).digest('hex'), byteLength: content.length, format }, bytes: content }
  } catch (error) {
    if (signal?.aborted) throw signal.reason
    return isMissingTurnFile(error) ? { snapshot: { availability: 'missing' } } : omitted('unreadable')
  } finally { await handle?.close() }
}

export function collectTurnLimitations(files: Iterable<CapturedTurnFile>): TurnChangeLimitation[] {
  return [...new Set([...files].flatMap(file => file.snapshot.reason ? [file.snapshot.reason] : []))]
}
