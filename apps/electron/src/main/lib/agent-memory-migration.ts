import type { MemoryMigrationItem, MemoryMigrationPlan, MemoryTarget, MemoryWriteAccess } from '@proma/shared'
import { assertMemoryRoots, assertMemoryWriteAccess, MAX_MEMORY_BYTES } from './agent-memory'
import type { AgentMemoryService } from './agent-memory'
import { memoryHash, resolveMemoryFile } from './agent-memory-targets'
import type { ResolvedMemoryTarget } from './agent-memory-targets'
import { scanMemoryFiles } from './memory-file-scan'
import { turnPathKey } from './turn-changes/paths'
import { commitRestoreFile, inspectRestoreFile } from './turn-changes/restore-files'

interface MigrationCandidate {
  item: MemoryMigrationItem
  root: string
  relativePath: string
  destinationRevision?: string | null
}

interface MigrationBackup {
  version: 1
  source: string
  path: string
  revision: string
  content: string
  applied: boolean
}

const MAX_MIGRATION_BYTES = 4 * MAX_MEMORY_BYTES
const MAX_BACKUP_BYTES = 6 * MAX_MEMORY_BYTES + 8192

function backupPath(target: MemoryTarget, item: MemoryMigrationItem): string {
  const key = memoryHash(JSON.stringify([item.source, item.path, item.revision]))
  return `agent-memory/migrations/${target.id}/${key}.json`
}

function readBackup(resolved: ResolvedMemoryTarget, item: MemoryMigrationItem) {
  const path = backupPath(resolved.target, item)
  const state = inspectRestoreFile(resolved.config.path, path, MAX_BACKUP_BYTES)
  const data = state.bytes ? JSON.parse(state.bytes.toString('utf8')) as Partial<MigrationBackup> | null : undefined
  if (state.bytes && (data?.version !== 1 || data.source !== item.source || data.path !== item.path ||
    data.revision !== item.revision || typeof data.applied !== 'boolean' || typeof data.content !== 'string' ||
    memoryHash(data.content) !== item.revision)) {
    throw new Error('迁移备份已损坏')
  }
  return { path, state, data: data as MigrationBackup | undefined }
}

function buildPlan(service: AgentMemoryService, target: MemoryTarget) {
  const resolved = service.resolveCurrentTarget(target)
  if (!resolved.workspaceSlug) throw new Error('旧工作区记忆只能导入当前项目')
  const workspace = `agent-workspaces/${resolved.workspaceSlug}`
  const sources = [
    ...(!resolved.managed ? [{ label: 'workspace', root: resolved.config.path, directory: `${workspace}/memory` }] : []),
    { label: 'workspace', root: resolved.config.path, directory: `${workspace}/.claude/memory` },
    ...(!resolved.managed ? [{ label: 'project', root: resolved.root.path, directory: '.claude/memory' }] : []),
  ]
  const reserved = new Set<string>()
  const candidates: MigrationCandidate[] = []
  let partial = false
  let budget = MAX_MIGRATION_BYTES
  for (const { label, root, directory } of sources) {
    const scanned = scanMemoryFiles(root, directory)
    partial ||= scanned.partial
    for (const relativePath of scanned.paths) {
      if (budget <= 0) { partial = true; break }
      const suffix = relativePath.startsWith(directory + '/') ? relativePath.slice(directory.length + 1) : ''
      const source = `${label}/${label === 'workspace' ? relativePath.slice(workspace.length + 1) : relativePath}`
      const item: MemoryMigrationItem = { source, status: 'unsupported' }
      const row: MigrationCandidate = { item, root, relativePath }
      candidates.push(row)
      if (!suffix.toLowerCase().endsWith('.md')) continue
      try {
        const path = suffix.toLowerCase() === 'memory.md' ? 'MEMORY.md' : `memory/${suffix}`
        resolveMemoryFile(resolved, path)
        const file = inspectRestoreFile(root, relativePath, MAX_MEMORY_BYTES)
        if (file.snapshot.format !== 'text' || !file.snapshot.hash || !file.bytes) continue
        budget -= file.bytes.length
        if (budget < 0) { partial = true; break }
        item.path = path
        item.revision = file.snapshot.hash
        const previous = readBackup(resolved, item).data
        const destination = service.inspect(target, path)
        row.destinationRevision = destination.revision
        if (previous?.applied) item.status = 'imported'
        else if (destination.revision === item.revision) item.status = previous ? 'ready' : 'present'
        else if (destination.revision !== null || reserved.has(turnPathKey(path))) item.status = 'conflict'
        else item.status = 'ready'
        if (item.status === 'ready') reserved.add(turnPathKey(path))
      } catch (error) {
        item.reason = error instanceof Error ? error.message : String(error)
      }
    }
  }
  assertMemoryRoots(resolved)
  const items = candidates.map(({ item }) => item)
  const id = memoryHash(JSON.stringify([target.id, candidates.map(({ item, destinationRevision }) => [item, destinationRevision]), partial]))
  return { resolved, candidates, plan: { id, items, partial } satisfies MemoryMigrationPlan }
}

export function previewMemoryMigration(service: AgentMemoryService, target: MemoryTarget): MemoryMigrationPlan {
  return buildPlan(service, target).plan
}

export function applyMemoryMigration(service: AgentMemoryService, target: MemoryTarget, access: MemoryWriteAccess, planId: string): MemoryMigrationPlan {
  assertMemoryWriteAccess(access)
  const { resolved, candidates, plan } = buildPlan(service, target)
  if (plan.id !== planId) throw new Error('迁移计划已变化，请重新预览')
  const { config } = resolved

  for (const { item, root, relativePath, destinationRevision } of candidates) {
    if (item.status !== 'ready' || !item.path || !item.revision) continue
    try {
      const source = inspectRestoreFile(root, relativePath, MAX_MEMORY_BYTES)
      if (source.snapshot.hash !== item.revision || source.snapshot.format !== 'text' || !source.bytes) {
        throw new Error('旧记忆正文已变化，请重新预览')
      }
      const content = source.bytes.toString('utf8')
      const backup: MigrationBackup = { version: 1, source: item.source, path: item.path, revision: item.revision, content, applied: false }
      const validate = (): void => {
        assertMemoryRoots(resolved)
        service.resolveCurrentTarget(target)
      }
      const version = readBackup(resolved, item)
      if (!version.data) {
        commitRestoreFile(config.path, version.path, version.state, Buffer.from(JSON.stringify(backup)), MAX_BACKUP_BYTES, validate)
      }
      const result = service.update(target, access, destinationRevision ?? null, content, item.path)
      if (result.status === 'conflict' || result.status === 'over-budget') {
        item.status = 'conflict'
        continue
      }
      const staged = readBackup(resolved, item)
      if (!staged.data) throw new Error('迁移备份已丢失')
      commitRestoreFile(config.path, staged.path, staged.state, Buffer.from(JSON.stringify({ ...staged.data, applied: true })), MAX_BACKUP_BYTES, validate)
      item.status = 'imported'
    } catch (error) {
      item.status = 'failed'
      item.reason = error instanceof Error ? error.message : String(error)
    }
  }
  return plan
}
