import { lstatSync, readdirSync, realpathSync } from 'node:fs'
import { join, relative } from 'node:path'
import type {
  MemoryDocument, MemoryFileList, MemoryHistoryEntry, MemoryRestorePreview, MemoryScope,
  MemorySearchResult, MemoryTarget, MemoryUsage, MemoryWriteAccess, MemoryWriteResult,
} from '@proma/shared'
import { resolveConfigDir } from './config-paths'
import { memoryHash, resolveMemoryFile, resolveMemoryTarget } from './agent-memory-targets'
import type { ResolvedMemoryTarget } from './agent-memory-targets'
import { scanMemoryFiles } from './memory-file-scan'
import { isMissingTurnFile, turnPathKey } from './turn-changes/paths'
import { assertRestoreRoot, commitRestoreFile, inspectRestoreFile } from './turn-changes/restore-files'
import type { RestoreFileState } from './turn-changes/restore-files'

export type { MemoryScope, MemoryTarget, MemoryWriteAccess, MemoryWriteResult } from '@proma/shared'

export const GLOBAL_MEMORY_LIMIT = 5000
export const MAX_MEMORY_BYTES = 1024 * 1024
// JSON 可能将一个字节的 ASCII 控制字符转义为六字节。
const MAX_HISTORY_BYTES = MAX_MEMORY_BYTES * 6 + 4096
const REVISION_PATTERN = /^[a-f0-9]{64}$/

interface StoredMemoryVersion extends MemoryHistoryEntry {
  version: 1
  targetId: string
  fileKey: string
  content: string
}

interface MemoryFile {
  resolved: ResolvedMemoryTarget
  path: string
  key: string
  state: RestoreFileState
  document: MemoryDocument
}

export function assertMemoryWriteAccess(access: MemoryWriteAccess): void {
  if (access.source !== 'user' || access.permissionMode !== 'bypassPermissions' || access.readOnly) {
    throw new Error('当前执行上下文没有记忆写入权限')
  }
}

function profileUsage(scope: MemoryScope, content: string | null): MemoryUsage | undefined {
  return scope.kind === 'global' ? { used: content?.length ?? 0, limit: GLOBAL_MEMORY_LIMIT } : undefined
}

function describeFile(file: RestoreFileState, scope: MemoryScope): MemoryDocument {
  if (file.snapshot.availability === 'available' && file.snapshot.format !== 'text') {
    throw new Error('记忆文件必须是有效的 UTF-8 文本')
  }
  const content = file.bytes?.toString('utf8') ?? null
  const revision = file.snapshot.hash ?? null
  return { content, revision, usage: profileUsage(scope, content) }
}

function archiveDirectory(target: MemoryTarget): string {
  return `agent-memory/archived/${target.id}`
}

function readArchivePath(state: RestoreFileState): string {
  if (!state.bytes || state.snapshot.format !== 'text') throw new Error('记忆归档索引损坏')
  const entry = JSON.parse(state.bytes.toString('utf8')) as { version?: number; path?: string } | null
  if (entry?.version !== 1 || typeof entry.path !== 'string') throw new Error('记忆归档索引损坏')
  return entry.path
}

function historyDirectory(file: MemoryFile): string {
  return `agent-memory/history/${file.resolved.target.id}/${file.key}`
}

export function assertMemoryRoots({ root, config }: ResolvedMemoryTarget): void {
  assertRestoreRoot(config.path, config.identity)
  if (root !== config) assertRestoreRoot(root.path, root.identity)
}

/** 主进程内部服务。调用方持有已授权工作区的目标，不能以任意路径作为记忆根。 */
export class AgentMemoryService {
  constructor(private readonly configPath = resolveConfigDir()) {}

  resolveTarget(scope: MemoryScope): MemoryTarget {
    return resolveMemoryTarget(this.configPath, scope).target
  }

  inspect(target: MemoryTarget, path?: string): MemoryDocument {
    return this.readFile(target, path).document
  }

  initialize(target: MemoryTarget, access: MemoryWriteAccess, path?: string): MemoryWriteResult {
    assertMemoryWriteAccess(access)
    const file = this.readFile(target, path)
    if (file.document.revision !== null) return { status: 'unchanged', document: file.document }
    return this.write(file, '', null)
  }

  update(target: MemoryTarget, access: MemoryWriteAccess, expectedRevision: string | null, content: string, path?: string): MemoryWriteResult {
    assertMemoryWriteAccess(access)
    return this.write(this.readFile(target, path), content, expectedRevision)
  }

  list(target: MemoryTarget): MemoryFileList {
    const resolved = this.resolveCurrentTarget(target)
    const primary = target.scope.kind === 'global' ? 'user_profile.md' : 'MEMORY.md'
    const scan = target.scope.kind === 'global'
      ? { paths: [], partial: false }
      : scanMemoryFiles(resolved.root.path, 'memory')
    const files = [primary]
    let partial = scan.partial || scan.paths.includes('memory')
    for (const path of scan.paths) {
      if (!path.toLowerCase().endsWith('.md')) continue
      if (resolved.managed && path.toLowerCase() === 'memory/memory.md') continue
      try {
        const relativePath = resolveMemoryFile(resolved, path)
        if (lstatSync(join(resolved.root.path, relativePath)).isFile()) files.push(path)
        else partial = true
      } catch { partial = true }
    }
    const archive = scanMemoryFiles(resolved.config.path, archiveDirectory(target), 0)
    const archived: string[] = []
    for (const path of archive.paths) {
      if (!REVISION_PATTERN.test(path.split('/').at(-1)?.slice(0, -5) ?? '') || !path.endsWith('.json')) continue
      try {
        const state = inspectRestoreFile(resolved.config.path, path, 8192)
        const entryPath = readArchivePath(state)
        const file = this.readResolvedFile(resolved, entryPath)
        if (path !== `${archiveDirectory(target)}/${file.key}.json`) throw new Error('记忆归档索引不匹配')
        if (file.document.revision === null) archived.push(entryPath)
      } catch { partial = true }
    }
    assertMemoryRoots(resolved)
    return { files, archived, partial: partial || archive.partial }
  }

  search(target: MemoryTarget, query: string): MemorySearchResult {
    const term = query.trim()
    if (!term || term.length > 200) throw new Error('请输入 1 到 200 个字符的搜索词')
    const pattern = new RegExp(term.replace(/[.*+?^$()|[\]{}\\]/g, '\\$&'), 'iu')
    const resolved = this.resolveCurrentTarget(target)
    const list = this.list(target)
    let partial = list.partial
    const hits: MemorySearchResult['hits'] = []
    let budget = 4 * MAX_MEMORY_BYTES
    for (const path of list.files) {
      let content: string
      try { content = this.readResolvedFile(resolved, path).document.content ?? '' }
      catch { partial = true; continue }
      budget -= Buffer.byteLength(content)
      if (budget < 0) return { hits, partial: true }
      let line = 0
      for (const text of content.split(/\r\n|\n|\r/u)) {
        line += 1
        const index = text.search(pattern)
        if (index < 0) continue
        if (hits.length >= 20) return { hits, partial: true }
        const start = Math.max(0, index - Math.min(45, 240 - term.length))
        const end = Math.min(text.length, start + 240)
        const snippet = (start > 0 ? '…' : '') + text.slice(start, end) + (end < text.length ? '…' : '')
        hits.push({ path, line, snippet })
      }
    }
    assertMemoryRoots(resolved)
    return { hits, partial }
  }

  restorePreview(target: MemoryTarget, revision: string, path?: string): MemoryRestorePreview {
    const file = this.readFile(target, path)
    const { content } = this.readVersion(file, revision)
    assertMemoryRoots(file.resolved)
    return { current: file.document, archived: { content, revision, usage: profileUsage(target.scope, content) } }
  }

  archive(target: MemoryTarget, access: MemoryWriteAccess, expectedRevision: string | null, path?: string): MemoryWriteResult {
    assertMemoryWriteAccess(access)
    const file = this.readFile(target, path)
    if (file.document.revision !== expectedRevision) {
      return { status: 'conflict', currentRevision: file.document.revision }
    }
    if (expectedRevision === null) return { status: 'unchanged', document: file.document }

    this.archiveCurrent(file)
    this.markArchived(file, path ?? (target.scope.kind === 'global' ? 'user_profile.md' : 'MEMORY.md'))
    this.commit(file)
    return { status: 'saved', document: { content: null, revision: null, usage: profileUsage(target.scope, null) } }
  }

  private markArchived(file: MemoryFile, path: string): void {
    const { config } = file.resolved
    const marker = `${archiveDirectory(file.resolved.target)}/${file.key}.json`
    const state = inspectRestoreFile(config.path, marker, 8192)
    if (state.bytes) {
      const archive = this.readResolvedFile(file.resolved, readArchivePath(state))
      if (archive.key !== file.key) throw new Error('记忆归档索引不匹配')
    } else {
      // 标记先于移除发布。若移除失败，文件仍存在，列表不会将它显示为已归档。
      const data = Buffer.from(JSON.stringify({ version: 1, path: path.replace(/\\/g, '/') }))
      commitRestoreFile(config.path, marker, state, data, 8192, () => assertMemoryRoots(file.resolved))
    }
  }

  hasImportedHistoryVersion(target: MemoryTarget, path: string, revision: string): boolean {
    if (!REVISION_PATTERN.test(revision)) throw new Error('无效的记忆 revision')
    const file = this.readFile(target, path)
    const { config } = file.resolved
    const state = inspectRestoreFile(config.path, `${historyDirectory(file)}/${revision}.json`, MAX_HISTORY_BYTES)
    if (!state.bytes) return false
    this.readVersion(file, revision)
    if (file.document.revision === null && path.startsWith('memory/')) {
      const marker = inspectRestoreFile(config.path, `${archiveDirectory(target)}/${file.key}.json`, 8192)
      if (!marker.bytes) return false
      if (this.readResolvedFile(file.resolved, readArchivePath(marker)).key !== file.key) throw new Error('记忆归档索引不匹配')
    }
    return true
  }

  /** 迁入历史只追加不可变版本，不改当前正文。历史独有主题通过归档列表保留恢复入口。 */
  importHistoryVersion(target: MemoryTarget, access: MemoryWriteAccess, path: string, content: string, savedAt: number): void {
    assertMemoryWriteAccess(access)
    const file = this.readFile(target, path)
    this.storeHistoryVersion(file, content, memoryHash(content), savedAt)
    if (file.document.revision === null && path.startsWith('memory/')) this.markArchived(file, path)
  }

  history(target: MemoryTarget, path?: string): MemoryHistoryEntry[] {
    const file = this.readFile(target, path)
    const { config } = file.resolved
    const directory = join(config.path, historyDirectory(file))
    let names: string[]
    try {
      const stats = lstatSync(directory)
      if (!stats.isDirectory() || turnPathKey(realpathSync(directory)) !== turnPathKey(directory)) {
        throw new Error('记忆历史路径必须是普通目录，且不能通过链接访问')
      }
      names = readdirSync(directory)
    } catch (error) {
      if (isMissingTurnFile(error)) return []
      throw error
    }
    const entries = names.flatMap((name) => {
      const revision = name.endsWith('.json') ? name.slice(0, -5) : ''
      if (!REVISION_PATTERN.test(revision) || revision === file.document.revision) return []
      const version = this.readVersion(file, revision)
      return [{ revision, savedAt: version.savedAt }]
    })
    assertMemoryRoots(file.resolved)
    return entries.sort((a, b) => b.savedAt - a.savedAt || a.revision.localeCompare(b.revision))
  }

  restore(target: MemoryTarget, access: MemoryWriteAccess, expectedRevision: string | null, revision: string, path?: string): MemoryWriteResult {
    assertMemoryWriteAccess(access)
    const file = this.readFile(target, path)
    if (file.document.revision !== expectedRevision) {
      return { status: 'conflict', currentRevision: file.document.revision }
    }
    if (file.document.revision === revision) return { status: 'unchanged', document: file.document }
    return this.write(file, this.readVersion(file, revision).content, expectedRevision)
  }

  resolveCurrentTarget(target: MemoryTarget): ResolvedMemoryTarget {
    const resolved = resolveMemoryTarget(this.configPath, target.scope)
    if (resolved.target.id !== target.id) throw new Error('记忆目标已改变，请重新读取')
    return resolved
  }

  private readFile(target: MemoryTarget, requestedPath?: string): MemoryFile {
    return this.readResolvedFile(this.resolveCurrentTarget(target), requestedPath)
  }

  private readResolvedFile(resolved: ResolvedMemoryTarget, requestedPath?: string): MemoryFile {
    const path = resolveMemoryFile(resolved, requestedPath)
    const state = inspectRestoreFile(resolved.root.path, path, MAX_MEMORY_BYTES)
    const canonicalPath = state.bytes
      ? relative(resolved.root.path, realpathSync.native(join(resolved.root.path, path)))
      : path
    const key = memoryHash(turnPathKey(canonicalPath.split(/[\\/]/).join('/')))
    assertMemoryRoots(resolved)
    return { resolved, path, key, state, document: describeFile(state, resolved.target.scope) }
  }

  private readVersion(file: MemoryFile, revision: string): StoredMemoryVersion {
    if (!REVISION_PATTERN.test(revision)) throw new Error('无效的记忆 revision')
    const directory = historyDirectory(file)
    const state = inspectRestoreFile(file.resolved.config.path, `${directory}/${revision}.json`, MAX_HISTORY_BYTES)
    if (state.snapshot.availability !== 'available' || !state.bytes) throw new Error('指定的记忆版本不存在')
    if (state.snapshot.format !== 'text') throw new Error('记忆历史已损坏')
    let stored: Partial<StoredMemoryVersion> | null
    try {
      stored = JSON.parse(state.bytes.toString('utf8')) as Partial<StoredMemoryVersion> | null
    } catch {
      throw new Error('记忆历史已损坏')
    }
    if (stored?.version !== 1 || stored.targetId !== file.resolved.target.id || stored.fileKey !== file.key
      || stored.revision !== revision || typeof stored.savedAt !== 'number' || !Number.isSafeInteger(stored.savedAt)
      || typeof stored.content !== 'string' || memoryHash(stored.content) !== revision) {
      throw new Error('记忆历史已损坏')
    }
    return stored as StoredMemoryVersion
  }

  private archiveCurrent(file: MemoryFile): void {
    const { content, revision } = file.document
    if (content === null || revision === null) return
    this.storeHistoryVersion(file, content, revision, Date.now())
  }

  private storeHistoryVersion(file: MemoryFile, content: string, revision: string, savedAt: number): void {
    const directory = historyDirectory(file)
    const path = `${directory}/${revision}.json`
    const { config, target } = file.resolved
    const state = inspectRestoreFile(config.path, path, MAX_HISTORY_BYTES)
    if (state.bytes) {
      this.readVersion(file, revision)
      return
    }
    const version: StoredMemoryVersion = {
      version: 1,
      targetId: target.id,
      fileKey: file.key,
      revision,
      savedAt,
      content,
    }
    const bytes = Buffer.from(JSON.stringify(version), 'utf8')
    commitRestoreFile(config.path, path, state, bytes, MAX_HISTORY_BYTES, () => {
      assertMemoryRoots(file.resolved)
      this.resolveCurrentTarget(target)
    })
  }

  private write(file: MemoryFile, content: string, expectedRevision: string | null): MemoryWriteResult {
    if (file.document.revision !== expectedRevision) {
      return { status: 'conflict', currentRevision: file.document.revision }
    }
    const usage = profileUsage(file.resolved.target.scope, content)
    if (usage && usage.used > usage.limit) return { status: 'over-budget', usage }
    if (content.length > MAX_MEMORY_BYTES || Buffer.byteLength(content) > MAX_MEMORY_BYTES) {
      throw new Error('记忆文件超过 1 MiB 的大小上限')
    }
    const bytes = Buffer.from(content, 'utf8')
    if (content.includes('\0') || bytes.toString('utf8') !== content) throw new Error('记忆内容必须是有效的 UTF-8 文本')
    const revision = memoryHash(bytes)
    if (file.document.revision === revision) return { status: 'unchanged', document: file.document }

    // 先保存已存在的正文。若随后写入失败，这份仍是当前版本，不会出现在历史列表。
    this.archiveCurrent(file)
    this.commit(file, bytes)
    return { status: 'saved', document: { content, revision, usage } }
  }

  private commit(file: MemoryFile, bytes?: Buffer): void {
    commitRestoreFile(file.resolved.root.path, file.path, file.state, bytes, MAX_MEMORY_BYTES, () => {
      assertMemoryRoots(file.resolved)
      this.resolveCurrentTarget(file.resolved.target)
    })
  }
}
