import type { AgentMemoryRequest, MemoryAction, MemoryScope, MemoryTarget, MemoryWriteAccess } from '@proma/shared'
import type { AgentMemoryService } from './agent-memory'
import { applyMemoryMigration, previewMemoryMigration } from './agent-memory-migration'
import { linkMemoryInstruction, previewMemoryInstruction } from './agent-memory-instructions'

export function memoryObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('记忆请求格式无效')
  return value as Record<string, unknown>
}

function requireText(value: unknown, label: string, max = 1024): string {
  if (typeof value !== 'string' || value.length > max) throw new Error(`${label}无效`)
  return value
}

function parseRevision(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw new Error('记忆 revision 无效')
  return value
}

function parseExpected(value: unknown): string | null {
  return value === null ? null : parseRevision(value)
}

function parseScope(value: unknown): MemoryScope {
  const scope = memoryObject(value)
  if (scope.kind === 'global') return { kind: 'global' }
  if (scope.kind === 'project') return { kind: 'project', workspaceId: requireText(scope.workspaceId, '工作区 ID', 128) }
  throw new Error('无效的记忆范围')
}

export function parseMemoryAction(input: Record<string, unknown>): MemoryAction {
  const action = input.action
  const path = input.path === undefined ? undefined : requireText(input.path, '记忆路径')
  switch (action) {
    case 'list': case 'migrationPreview': case 'instructionPreview': return { action }
    case 'inspect': case 'initialize': case 'history': return { action, path }
    case 'search': return { action, query: requireText(input.query, '搜索词', 200) }
    case 'archive': return { action, path, expectedRevision: parseExpected(input.expectedRevision) }
    case 'update': return { action, path, expectedRevision: parseExpected(input.expectedRevision), content: requireText(input.content, '记忆正文', 1024 * 1024) }
    case 'restorePreview': return { action, path, revision: parseRevision(input.revision) }
    case 'restore': return { action, path, revision: parseRevision(input.revision), expectedRevision: parseExpected(input.expectedRevision) }
    case 'migrate': return { action, planId: parseRevision(input.planId) }
    case 'linkInstruction': return { action, expectedRevision: parseExpected(input.expectedRevision) }
    default: throw new Error('不支持的记忆操作')
  }
}

export function parseAgentMemoryRequest(value: unknown): AgentMemoryRequest {
  const input = memoryObject(value)
  if (input.action === 'target') return { action: 'target', scope: parseScope(input.scope) }
  const target = memoryObject(input.target)
  return { ...parseMemoryAction(input), target: { id: parseRevision(target.id), scope: parseScope(target.scope) } }
}

export function isMemoryWrite(action: MemoryAction['action']): boolean {
  return action === 'initialize' || action === 'update' || action === 'archive' || action === 'restore' || action === 'migrate' || action === 'linkInstruction'
}

export function executeMemoryAction(service: AgentMemoryService, target: MemoryTarget, request: MemoryAction, access: MemoryWriteAccess) {
  switch (request.action) {
    case 'list': return service.list(target)
    case 'inspect': return service.inspect(target, request.path)
    case 'initialize': return service.initialize(target, access, request.path)
    case 'update': return service.update(target, access, request.expectedRevision, request.content, request.path)
    case 'archive': return service.archive(target, access, request.expectedRevision, request.path)
    case 'history': return service.history(target, request.path)
    case 'restorePreview': return service.restorePreview(target, request.revision, request.path)
    case 'restore': return service.restore(target, access, request.expectedRevision, request.revision, request.path)
    case 'search': return service.search(target, request.query)
    case 'migrationPreview': return previewMemoryMigration(service, target)
    case 'migrate': return applyMemoryMigration(service, target, access, request.planId)
    case 'instructionPreview': return previewMemoryInstruction(service, target)
    case 'linkInstruction': return linkMemoryInstruction(service, target, access, request.expectedRevision)
  }
}
