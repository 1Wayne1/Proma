import { createHash } from 'node:crypto'
import { lstat, mkdir, open, opendir, realpath, rm, unlink } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { TurnChangeOwner, TurnChangeRecord, TurnFileSnapshot } from '@proma/shared'
import { writeTextFileAtomic } from '../safe-file'
import { validateTurnLimits } from './capture'
import { isMissingTurnFile, isWithinTurnRoot, normalizeTurnPath, turnPathKey } from './paths'

const RECORD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const HASH = /^[0-9a-f]{64}$/
const MAX_MANIFEST_BYTES = 8 * 1024 * 1024
const omissions = new Set(['too-large', 'budget-exceeded', 'unsafe-path', 'not-file', 'unreadable', 'changed-during-read', 'not-captured'])
const limitations = new Set([...omissions, 'file-limit', 'git-output-limit', 'git-unavailable', 'git-timeout', 'git-invalid-path', 'additional-root-not-captured'])

function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function keys(value: Record<string, unknown>, allowed: string[]): boolean { return Object.keys(value).every(key => allowed.includes(key)) }
function integer(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 }
export function validTurnOwner(value: unknown): value is TurnChangeOwner {
  return object(value) && ['sessionId', 'turnId', 'workspaceId'].every(key => typeof value[key] === 'string' && value[key].length > 0 && value[key].length <= 256 && !value[key].includes('\0'))
}
export function sameTurnOwner(a: TurnChangeOwner, b: TurnChangeOwner): boolean {
  return a.sessionId === b.sessionId && a.turnId === b.turnId && a.workspaceId === b.workspaceId
}
function validSnapshot(value: unknown): value is TurnFileSnapshot {
  if (!object(value)) return false
  if (value.availability === 'missing') return keys(value, ['availability'])
  if (value.availability === 'omitted') return keys(value, ['availability', 'reason', 'byteLength']) && typeof value.reason === 'string' && omissions.has(value.reason) && (value.byteLength === undefined || integer(value.byteLength))
  return value.availability === 'available' && keys(value, ['availability', 'hash', 'byteLength', 'format']) && typeof value.hash === 'string' && HASH.test(value.hash) && integer(value.byteLength) && (value.format === 'text' || value.format === 'binary')
}

/** 持久化输入也按不可信 JSON 校验，禁止用快照引用拼出任意磁盘路径。 */
function validRecord(value: unknown): value is TurnChangeRecord {
  if (!object(value) || !validTurnOwner(value) || !keys(value, ['schemaVersion', 'recordId', 'sessionId', 'turnId', 'workspaceId', 'canonicalCwd', 'startedAt', 'endedAt', 'completion', 'partial', 'coverage', 'limits', 'limitations', 'files'])) return false
  if (value.schemaVersion !== 1 || typeof value.recordId !== 'string' || !RECORD_ID.test(value.recordId) || typeof value.canonicalCwd !== 'string' || resolve(value.canonicalCwd) !== value.canonicalCwd || !integer(value.startedAt) || typeof value.partial !== 'boolean') return false
  if (!['recording', 'completed', 'cancelled', 'failed'].includes(String(value.completion)) || (value.completion === 'recording' ? value.endedAt !== null : !integer(value.endedAt) || value.endedAt < value.startedAt)) return false
  if (!object(value.coverage) || !keys(value.coverage, ['mode', 'externalWrites']) || !['git-observed', 'controlled-only'].includes(String(value.coverage.mode)) || value.coverage.externalWrites !== (value.coverage.mode === 'git-observed' ? 'observed' : 'not-observed')) return false
  if (!object(value.limits) || Object.keys(value.limits).length !== 5 || !keys(value.limits, ['maxFiles', 'maxFileBytes', 'maxSnapshotBytes', 'maxGitOutputBytes', 'gitTimeoutMs'])) return false
  try { validateTurnLimits(value.limits) } catch { return false }
  if (!Array.isArray(value.limitations) || value.limitations.length > limitations.size || !value.limitations.every(item => typeof item === 'string' && limitations.has(item))) return false
  if (!Array.isArray(value.files) || value.files.length > Number(value.limits.maxFiles)) return false
  const paths = new Set<string>()
  const blobs = new Map<string, number>()
  for (const file of value.files) {
    if (!object(file) || !keys(file, ['path', 'kind', 'source', 'before', 'after']) || typeof file.path !== 'string' || !['added', 'modified', 'deleted', 'unknown'].includes(String(file.kind)) || !['controlled-tool', 'git-observed'].includes(String(file.source)) || !validSnapshot(file.before) || !validSnapshot(file.after)) return false
    try { if (normalizeTurnPath(file.path) !== file.path || paths.has(turnPathKey(file.path))) return false } catch { return false }
    paths.add(turnPathKey(file.path))
    for (const snapshot of [file.before, file.after]) {
      if (snapshot.availability !== 'available') continue
      if (snapshot.byteLength! > Number(value.limits.maxFileBytes) || (blobs.has(snapshot.hash!) && blobs.get(snapshot.hash!) !== snapshot.byteLength)) return false
      blobs.set(snapshot.hash!, snapshot.byteLength!)
    }
  }
  return [...blobs.values()].reduce((sum, bytes) => sum + bytes, 0) <= Number(value.limits.maxSnapshotBytes)
}

export class TurnChangeStore {
  private root: string | undefined
  private readonly storageRoot: string
  constructor(storageRoot: string) { this.storageRoot = resolve(storageRoot) }

  private async indexFile(owner: TurnChangeOwner, create = false): Promise<string> {
    if (!validTurnOwner(owner)) throw new Error('无效的逐轮记录归属')
    const directory = join(await this.getRoot(), 'turn-index')
    if (create) { try { await mkdir(directory, { mode: 0o700 }) } catch (error) { if (!object(error) || error.code !== 'EEXIST') throw error } }
    if ((await lstat(directory)).isSymbolicLink() || await realpath(directory) !== directory) throw new Error('逐轮索引目录越界')
    const key = createHash('sha256').update(JSON.stringify([owner.workspaceId, owner.sessionId, owner.turnId])).digest('hex')
    return join(directory, `${key}.json`)
  }

  private async indexIds(owner: TurnChangeOwner): Promise<string[]> {
    try {
      await lstat(this.storageRoot)
      const data: unknown = JSON.parse((await this.readPrivateFile(await this.indexFile(owner), 4096)).toString('utf8'))
      if (!object(data) || !keys(data, ['schemaVersion', 'recordIds']) || data.schemaVersion !== 1 || !Array.isArray(data.recordIds) || data.recordIds.length > 10 || !data.recordIds.every(id => typeof id === 'string' && RECORD_ID.test(id))) throw new Error('无效的逐轮索引')
      return data.recordIds
    } catch (error) { if (isMissingTurnFile(error)) return []; throw error }
  }

  async index(record: TurnChangeRecord): Promise<void> {
    if (!validRecord(record)) throw new Error('无效的逐轮记录')
    const ids = await this.indexIds(record)
    const next = [...ids.filter(id => id !== record.recordId), record.recordId].slice(-10)
    writeTextFileAtomic(await this.indexFile(record, true), JSON.stringify({ schemaVersion: 1, recordIds: next }))
    // 索引先提交，淘汰失败只留下可重试清理的数据，不损坏新索引。
    for (const id of ids.filter(id => !next.includes(id))) {
      try { const old = await this.read(record, id); if (old.completion !== 'recording') await this.discardUnpublished(id, old) }
      catch { /* 启动/定时维护会重试，不能让清理阻止 Agent 开始。 */ }
    }
  }

  async list(owner: TurnChangeOwner): Promise<TurnChangeRecord[]> {
    if (!validTurnOwner(owner)) throw new Error('无效的逐轮记录归属')
    const result: TurnChangeRecord[] = []
    for (const id of (await this.indexIds(owner)).slice().reverse()) {
      try { result.push(await this.read(owner, id)) } catch (error) { if (!isMissingTurnFile(error)) throw error }
    }
    return result
  }

  private async getRoot(): Promise<string> {
    if (!this.root) {
      await mkdir(this.storageRoot, { recursive: true, mode: 0o700 })
      if ((await lstat(this.storageRoot)).isSymbolicLink()) throw new Error('逐轮快照存储不能是目录联接')
      this.root = await realpath(this.storageRoot)
    }
    if (await realpath(this.storageRoot) !== this.root || await realpath(this.root) !== this.root || (await lstat(this.root)).isSymbolicLink()) throw new Error('逐轮快照存储根已改变')
    return this.root
  }

  private async directory(id: string, create = false): Promise<string> {
    if (!RECORD_ID.test(id)) throw new Error('无效的逐轮记录标识')
    const root = await this.getRoot()
    const directory = join(root, id)
    if (create) { try { await mkdir(directory, { mode: 0o700 }) } catch (error) { if (!object(error) || error.code !== 'EEXIST') throw error } }
    if ((await lstat(directory)).isSymbolicLink() || await realpath(directory) !== directory || !isWithinTurnRoot(root, directory)) throw new Error('逐轮记录目录越界')
    return directory
  }

  private async blobDirectory(id: string, create = false): Promise<string> {
    const directory = join(await this.directory(id), 'snapshots')
    if (create) { try { await mkdir(directory, { mode: 0o700 }) } catch (error) { if (!object(error) || error.code !== 'EEXIST') throw error } }
    if ((await lstat(directory)).isSymbolicLink() || await realpath(directory) !== directory) throw new Error('逐轮快照目录越界')
    return directory
  }

  private async readPrivateFile(path: string, maxBytes: number): Promise<Buffer> {
    if (await realpath(path) !== path) throw new Error('逐轮持久化文件路径已改变')
    const before = await lstat(path)
    if (!before.isFile() || before.isSymbolicLink() || before.size > maxBytes) throw new Error('无效的逐轮持久化文件')
    const handle = await open(path, 'r')
    try {
      const stats = await handle.stat()
      if (stats.dev !== before.dev || stats.ino !== before.ino || stats.size !== before.size) throw new Error('逐轮持久化文件已改变')
      const bytes = Buffer.alloc(before.size + 1)
      let offset = 0
      while (offset < bytes.length) {
        const read = await handle.read(bytes, offset, bytes.length - offset, offset)
        if (!read.bytesRead) break
        offset += read.bytesRead
      }
      const after = await handle.stat()
      if (offset !== before.size || after.size !== before.size || after.mtimeMs !== stats.mtimeMs || await realpath(path) !== path) throw new Error('逐轮持久化文件已改变')
      return bytes.subarray(0, offset)
    } finally { await handle.close() }
  }

  async save(record: TurnChangeRecord, blobs: ReadonlyMap<string, Buffer>): Promise<void> {
    if (!validRecord(record)) throw new Error('无效的逐轮记录内容')
    let supplied = 0
    for (const [hash, bytes] of blobs) {
      supplied += bytes.length
      if (!HASH.test(hash) || createHash('sha256').update(bytes).digest('hex') !== hash || bytes.length > record.limits.maxFileBytes || supplied > record.limits.maxSnapshotBytes) throw new Error('无效的逐轮快照内容')
    }
    const directory = await this.directory(record.recordId, true)
    try {
      const previous = await this.read(record, record.recordId)
      if (previous.completion !== 'recording' || !sameTurnOwner(previous, record) || previous.canonicalCwd !== record.canonicalCwd) throw new Error('逐轮记录不可覆盖')
    } catch (error) { if (!isMissingTurnFile(error)) throw error }
    const blobDirectory = await this.blobDirectory(record.recordId, true)
    const created: string[] = []
    try {
      for (const [hash, bytes] of blobs) {
        let handle: Awaited<ReturnType<typeof open>>
        try {
          handle = await open(join(blobDirectory, hash), 'wx', 0o600)
        } catch (error) {
          if (!object(error) || error.code !== 'EEXIST') throw error
          const previous = await this.readPrivateFile(join(blobDirectory, hash), record.limits.maxFileBytes)
          if (!previous.equals(bytes)) throw new Error('逐轮快照完整性校验失败')
          continue
        }
        created.push(hash)
        try { await handle.writeFile(bytes) } finally { await handle.close() }
      }
      // 元数据最后提交，原子替换失败时保留上一份可读记录。
      writeTextFileAtomic(join(directory, 'record.json'), JSON.stringify(record))
    } catch (error) {
      // 新内容没有发布到元数据，不能因反复失败留下无界的孤立快照。
      if (await this.blobDirectory(record.recordId) === blobDirectory) {
        for (const hash of created) await unlink(join(blobDirectory, hash)).catch(() => {})
      }
      throw error
    }
  }

  async read(owner: TurnChangeOwner, id: string): Promise<TurnChangeRecord> {
    if (!validTurnOwner(owner)) throw new Error('无效的逐轮记录归属')
    const bytes = await this.readPrivateFile(join(await this.directory(id), 'record.json'), MAX_MANIFEST_BYTES)
    const record: unknown = JSON.parse(bytes.toString('utf8'))
    if (!validRecord(record) || record.recordId !== id || !sameTurnOwner(owner, record)) throw new Error('逐轮记录不存在或不属于当前会话')
    return record
  }

  async readBytes(owner: TurnChangeOwner, id: string, path: string, side: 'before' | 'after'): Promise<Buffer> {
    if (side !== 'before' && side !== 'after') throw new Error('无效的快照方向')
    const record = await this.read(owner, id)
    const key = turnPathKey(normalizeTurnPath(path))
    const file = record.files.find(file => turnPathKey(file.path) === key)
    const snapshot = file?.[side]
    if (!snapshot || snapshot.availability !== 'available') throw new Error('此文件没有可用快照')
    const bytes = await this.readPrivateFile(join(await this.blobDirectory(id), snapshot.hash!), record.limits.maxFileBytes)
    if (bytes.length !== snapshot.byteLength || createHash('sha256').update(bytes).digest('hex') !== snapshot.hash) throw new Error('逐轮快照完整性校验失败')
    return bytes
  }

  async readText(owner: TurnChangeOwner, id: string, path: string, side: 'before' | 'after'): Promise<string> {
    const record = await this.read(owner, id)
    const file = record.files.find(file => turnPathKey(file.path) === turnPathKey(normalizeTurnPath(path)))
    if (file?.[side].format !== 'text') throw new Error('此文件没有可预览的文本快照')
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(await this.readBytes(owner, id, path, side))
  }


  /** 只清理可验证的私有 UUID 记录；绝不跟随目录联接或删除项目文件。 */
  async cleanup(options: { liveSessionIds?: ReadonlySet<string>; isSessionLive?: (sessionId: string) => boolean; isRecordActive?: (recordId: string) => boolean; sessionId?: string; now?: number; maxRecords?: number }): Promise<{ removed: number; skipped: number; partial: boolean }> {
    const result = { removed: 0, skipped: 0, partial: false }
    try { await lstat(this.storageRoot) } catch (error) { if (isMissingTurnFile(error)) return result; throw error }
    const root = await this.getRoot()
    const directory = await opendir(root)
    let count = 0
    for await (const entry of directory) {
      if (!RECORD_ID.test(entry.name)) continue
      if (++count > (options.maxRecords ?? 10000)) { result.partial = true; break }
      try {
        const bytes = await this.readPrivateFile(join(await this.directory(entry.name), 'record.json'), MAX_MANIFEST_BYTES)
        const record: unknown = JSON.parse(bytes.toString('utf8'))
        if (!validRecord(record) || record.recordId !== entry.name) { result.skipped++; continue }
        const deletedSession = options.sessionId !== undefined ? record.sessionId === options.sessionId : options.isSessionLive !== undefined ? !options.isSessionLive(record.sessionId) : options.liveSessionIds !== undefined && !options.liveSessionIds.has(record.sessionId)
        const expired = options.sessionId === undefined && record.completion !== 'recording' && (options.now ?? Date.now()) - (record.endedAt ?? record.startedAt) > 30 * 24 * 60 * 60 * 1000
        const staleRecording = options.sessionId === undefined && options.isRecordActive !== undefined && record.completion === 'recording' && !options.isRecordActive(record.recordId) && (options.now ?? Date.now()) - record.startedAt > 24 * 60 * 60 * 1000
        // 缺失会话的未收束记录只在启动或 stopAndDrain 后清理。
        if (deletedSession || expired || staleRecording) { await this.discardUnpublished(record.recordId, record); result.removed++ }
      } catch { result.skipped++ }
    }
    return result
  }

  /** 只用于私有 UUID 记录；调用方必须先结束对应采样。 */
  async discardUnpublished(id: string, owner?: TurnChangeOwner): Promise<void> {
    if (!RECORD_ID.test(id)) throw new Error('无效的逐轮记录标识')
    // 不为一个失败的 begin 创建存储目录，尤其不能改动被拒绝的项目内路径。
    try { await lstat(join(this.storageRoot, id)) } catch (error) { if (isMissingTurnFile(error)) return; throw error }
    let directory: string
    try { directory = await this.directory(id) } catch (error) { if (isMissingTurnFile(error)) return; throw error }
    const root = await this.getRoot()
    if (directory === root || !isWithinTurnRoot(root, directory)) throw new Error('拒绝清理逐轮存储之外的路径')
    await rm(directory, { recursive: true, force: true })
    if (owner) {
      const ids = await this.indexIds(owner)
      if (ids.includes(id)) writeTextFileAtomic(await this.indexFile(owner), JSON.stringify({ schemaVersion: 1, recordIds: ids.filter(value => value !== id) }))
    }
  }
}
