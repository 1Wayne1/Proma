import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'
import type { AgentWorkspace, MemoryScope, MemoryTarget } from '@proma/shared'
import { getAgentWorkspacesIndexPath, resolveAgentWorkspacePath } from './config-paths'
import { inspectRestoreFile, restoreRootIdentity } from './turn-changes/restore-files'
import type { RootIdentity } from './turn-changes/restore-files'
import { normalizeTurnPath, turnPathKey } from './turn-changes/paths'

interface MemoryRoot {
  path: string
  identity: RootIdentity
}

export interface ResolvedMemoryTarget {
  target: MemoryTarget
  config: MemoryRoot
  root: MemoryRoot
  managed: boolean
  workspaceSlug?: string
}

export function memoryHash(bytes: string | Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function readRoot(path: string): MemoryRoot {
  if (!isAbsolute(path)) throw new Error('记忆根必须是已授权的绝对目录')
  const canonical = realpathSync(path)
  if (turnPathKey(resolve(path)) !== turnPathKey(canonical)) {
    throw new Error('记忆根不能通过符号链接或目录联接访问')
  }
  return { path: canonical, identity: restoreRootIdentity(canonical) }
}

function readWorkspace(config: MemoryRoot, workspaceId: string): AgentWorkspace {
  // 此查询不可调用会迁移索引或创建目录的工作区 getter。
  const indexPath = relative(config.path, getAgentWorkspacesIndexPath(config.path))
  const index = inspectRestoreFile(config.path, indexPath, 8 * 1024 * 1024)
  if (index.snapshot.format === 'binary') throw new Error('工作区索引必须是有效的 UTF-8 文本')
  const data = index.bytes ? JSON.parse(index.bytes.toString('utf8')) as { workspaces?: AgentWorkspace[] } : undefined
  const workspace = Array.isArray(data?.workspaces) && data.workspaces.find((entry) => entry?.id === workspaceId)
  if (!workspace) throw new Error('记忆工作区不存在或已失去授权')
  return workspace
}

export function resolveMemoryTarget(configPath: string, scope: MemoryScope): ResolvedMemoryTarget {
  const config = readRoot(configPath)
  let root = config
  let managed = false
  let workspaceSlug: string | undefined
  if (scope.kind === 'project') {
    const workspace = readWorkspace(config, scope.workspaceId)
    managed = workspace.projectRootPath === undefined
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(workspace.slug)) {
      throw new Error('无效的受管记忆工作区')
    }
    workspaceSlug = workspace.slug
    const path = managed ? resolveAgentWorkspacePath(workspace.slug, config.path) : workspace.projectRootPath
    if (typeof path !== 'string') throw new Error('无效的项目记忆根')
    root = readRoot(path)
  }
  const id = memoryHash(JSON.stringify([managed ? 'managed' : scope.kind, turnPathKey(root.path), root.identity.dev, root.identity.ino]))
  return { target: { id, scope: { ...scope } }, config, root, managed, workspaceSlug }
}

/** 逻辑索引名统一为 MEMORY.md，受管工作区映射到既有的 memory/MEMORY.md。 */
export function resolveMemoryFile(resolved: ResolvedMemoryTarget, input?: string): string {
  if (resolved.target.scope.kind === 'global') {
    if (input !== undefined && input !== 'user_profile.md') throw new Error('全局记忆只允许访问 user_profile.md')
    return 'user_profile.md'
  }
  if (input === undefined || input === 'MEMORY.md') return resolved.managed ? 'memory/MEMORY.md' : 'MEMORY.md'
  const path = normalizeTurnPath(input)
  if (!/^memory\/(?:[^/]+\/){0,7}[^/]+\.md$/iu.test(path) || (resolved.managed && path.toLowerCase() === 'memory/memory.md')) {
    throw new Error('项目记忆仅允许访问 MEMORY.md 或 memory/ 下的 Markdown 文件')
  }
  return path
}
