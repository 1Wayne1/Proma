import { constants, closeSync, fstatSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, rmdirSync, unlinkSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import type { TurnFileSnapshot } from '@proma/shared'
import { writeBytesFileAtomic } from '../safe-file'
import { isMissingTurnFile, normalizeTurnPath } from './paths'

export interface RootIdentity { dev: number; ino: number }
export interface RestoreFileState {
  snapshot: TurnFileSnapshot
  bytes?: Buffer
  identity: string
  parents: string
  mode?: number
}

export function restoreRootIdentity(root: string): RootIdentity {
  const stats = lstatSync(root)
  if (!stats.isDirectory() || stats.isSymbolicLink() || realpathSync(root) !== root) throw new Error('项目根已改变')
  return { dev: stats.dev, ino: stats.ino }
}

export function assertRestoreRoot(root: string, expected: RootIdentity): void {
  const actual = restoreRootIdentity(root)
  if (actual.dev !== expected.dev || actual.ino !== expected.ino) throw new Error('项目根身份已改变')
}

/** 每层目录均拒绝链接；恢复不跟随内部链接，也不写 Git 元数据。 */
function targetInfo(root: string, path: string): { target: string; parents: string } {
  const parts = normalizeTurnPath(path).split('/')
  let current = root
  const identities: string[] = []
  for (const part of parts.slice(0, -1)) {
    current = join(current, part)
    try {
      const stat = lstatSync(current)
      if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(current) !== current) throw new Error('文件祖先路径已改变')
      identities.push(`${current}:${stat.dev}:${stat.ino}`)
    } catch (error) {
      if (!isMissingTurnFile(error)) throw error
      identities.push(`${current}:missing`)
    }
  }
  return { target: join(root, ...parts), parents: JSON.stringify(identities) }
}

export function inspectRestoreFile(root: string, path: string, maxBytes: number): RestoreFileState {
  const target = targetInfo(root, path)
  let descriptor: number | undefined
  try {
    const before = lstatSync(target.target)
    if (!before.isFile() || before.isSymbolicLink() || before.size > maxBytes) throw new Error('当前文件不可安全恢复')
    descriptor = openSync(target.target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    const opened = fstatSync(descriptor)
    if (opened.dev !== before.dev || opened.ino !== before.ino) throw new Error('当前文件身份已改变')
    const buffer = Buffer.alloc(before.size + 1)
    let size = 0
    while (size < buffer.length) {
      const count = readSync(descriptor, buffer, size, buffer.length - size, size)
      if (!count) break
      size += count
    }
    const after = fstatSync(descriptor)
    const latest = lstatSync(target.target)
    if (size !== before.size || after.size !== before.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs || latest.isSymbolicLink() || latest.dev !== opened.dev || latest.ino !== opened.ino || latest.size !== after.size || latest.mtimeMs !== after.mtimeMs || targetInfo(root, path).parents !== target.parents) throw new Error('当前文件正在变化')
    const bytes = buffer.subarray(0, size)
    let format: 'text' | 'binary' = 'text'
    try { if (bytes.includes(0)) format = 'binary'; else new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch { format = 'binary' }
    return { snapshot: { availability: 'available', hash: createHash('sha256').update(bytes).digest('hex'), byteLength: size, format }, bytes,
      identity: `${opened.dev}:${opened.ino}:${opened.mode}:${opened.ctimeMs}:${opened.mtimeMs}`, parents: target.parents, mode: opened.mode & 0o777 }
  } catch (error) {
    if (!isMissingTurnFile(error)) throw error
    return { snapshot: { availability: 'missing' }, identity: 'missing', parents: target.parents }
  } finally { if (descriptor !== undefined) closeSync(descriptor) }
}

export function sameRestoreContent(first: TurnFileSnapshot, second: TurnFileSnapshot): boolean {
  return first.availability === 'missing' && second.availability === 'missing'
    || first.availability === 'available' && second.availability === 'available' && first.hash === second.hash && first.byteLength === second.byteLength
}

/** 最后一次 hash/身份检查与提交均同步执行，避免主进程其它请求插入。 */
export function commitRestoreFile(root: string, path: string, expected: RestoreFileState, bytes: Buffer | undefined, maxBytes: number, check: () => void): void {
  const created: string[] = []
  const validate = (parents = expected.parents): void => {
    check()
    const latest = inspectRestoreFile(root, path, maxBytes)
    if (latest.parents !== parents || latest.identity !== expected.identity || !sameRestoreContent(latest.snapshot, expected.snapshot)) throw new Error('文件已在预览后改变')
  }
  validate()
  try {
    const target = join(root, normalizeTurnPath(path))
    if (bytes === undefined) { validate(); unlinkSync(target); return }
    let current = root
    for (const part of normalizeTurnPath(path).split('/').slice(0, -1)) {
      current = join(current, part)
      try { mkdirSync(current); created.push(current) } catch (error) {
        if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'EEXIST') throw error
      }
      targetInfo(root, path)
    }
    const parents = targetInfo(root, path).parents
    writeBytesFileAtomic(target, bytes, { mode: expected.mode, exclusive: expected.snapshot.availability === 'missing', beforeCommit: () => validate(parents) })
  } catch (error) {
    for (const directory of created.reverse()) { try { rmdirSync(directory) } catch { /* 非空目录或外部改动必须保留。 */ } }
    throw error
  }
}
