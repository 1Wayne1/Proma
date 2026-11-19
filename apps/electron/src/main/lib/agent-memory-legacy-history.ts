import { lstatSync } from 'node:fs'
import { basename, join } from 'node:path'
import { MAX_MEMORY_BYTES } from './agent-memory'
import { memoryHash } from './agent-memory-targets'
import type { ResolvedMemoryTarget } from './agent-memory-targets'
import { scanMemoryFiles } from './memory-file-scan'
import { inspectRestoreFile } from './turn-changes/restore-files'

export const LEGACY_PROFILE_PATH = 'memory/user_profile.md'
const MAX_METADATA_BYTES = 32 * 1024
const HISTORY_NAME = /^([a-f0-9]{64})\.md$/
const THEMENAME = /^[a-zA-Z0-9][a-zA-Z0-9_-]*\.md$/
// 0.22.80 将删除的主题存为时间戳-UUID-原文件名，历史桶仍按原路径索引。
const ARCHIVED_THEME = /^\d+-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}-(.+)$/

export function findLegacyHistoryFiles(resolved: ResolvedMemoryTarget) {
  const { config, workspaceSlug } = resolved
  if (!workspaceSlug) return { partial: false, files: [{ sourcePath: LEGACY_PROFILE_PATH, path: 'user_profile.md' }] }
  const directory = `agent-workspaces/${workspaceSlug}/memory`
  const scan = scanMemoryFiles(config.path, directory)
  const names = new Set(['MEMORY.md', 'project-preferences.md'])
  for (const source of scan.paths) {
    const relative = source.slice(directory.length + 1)
    const name = relative.startsWith('archive/') && relative.split('/').length === 2
      ? ARCHIVED_THEME.exec(basename(relative))?.[1]
      : relative
    if (name && THEMENAME.test(name) && name !== 'user_profile.md' && name !== 'user-profile.md') names.add(name)
  }
  return {
    partial: scan.partial,
    files: [...names].map(name => ({
      sourcePath: `${directory}/${name}`,
      path: name === 'MEMORY.md' ? name : `memory/${name}`,
    })),
  }
}

export function scanLegacyHistory(root: string, sourcePath: string) {
  // 旧版用解析过的源文件绝对路径分桶，不能将全局历史目录当作跨项目索引。
  const directory = `memory/history/${memoryHash(join(root, sourcePath))}`
  return scanMemoryFiles(root, directory, 0)
}

export function readLegacyHistory(root: string, source: string) {
  const legacyRevision = HISTORY_NAME.exec(basename(source))?.[1]
  if (!legacyRevision) throw new Error('旧历史文件名无效')
  const { snapshot, bytes } = inspectRestoreFile(root, source, MAX_MEMORY_BYTES)
  const content = bytes?.toString('utf8')
  // 0.22.80 的 revision 含 file\0 前缀，导入后使用新格式的内容 hash。
  if (!bytes || snapshot.format !== 'text' || content === undefined || memoryHash(`file\0${content}`) !== legacyRevision) {
    throw new Error('旧历史版本内容与文件名不匹配')
  }
  let savedAt = Math.trunc(lstatSync(join(root, source)).mtimeMs)
  try {
    const meta = inspectRestoreFile(root, `${source.slice(0, -3)}.json`, MAX_METADATA_BYTES)
    const data = meta.bytes && JSON.parse(meta.bytes.toString('utf8')) as { revision?: unknown; savedAt?: unknown } | null
    if (data && data.revision === legacyRevision && typeof data.savedAt === 'number' &&
      Number.isFinite(data.savedAt) && data.savedAt >= 0 && data.savedAt <= 8.64e15) {
      savedAt = Math.trunc(data.savedAt)
    }
  } catch { /* 旧版缺失或损坏的时间戳侧车回退到 Markdown 修改时间。 */ }
  return { content, revision: memoryHash(bytes), savedAt, byteLength: bytes.length }
}
