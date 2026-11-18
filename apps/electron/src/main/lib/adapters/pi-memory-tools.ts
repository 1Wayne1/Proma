import { Type } from 'typebox'
import { join } from 'node:path'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { MemoryTarget, MemoryWriteAccess } from '@proma/shared'
import { AgentMemoryService, assertMemoryWriteAccess } from '../agent-memory'
import { resolveMemoryFile } from '../agent-memory-targets'
import { executeMemoryAction, isMemoryWrite, memoryObject, parseMemoryAction } from '../agent-memory-actions'

interface PiMemoryContext {
  workspaceId?: string
  isCurrent: () => boolean
  getAccess: () => MemoryWriteAccess
  service?: AgentMemoryService
  beforeProjectFileWrite?: (path: string, signal?: AbortSignal) => Promise<void> | undefined
}

const scopeParameter = Type.Union([Type.Literal('project'), Type.Literal('global')])
const pathParameter = Type.Optional(Type.String({ maxLength: 1024, description: '逻辑相对路径，如 MEMORY.md、memory/主题.md 或 user_profile.md' }))
const revisionParameter = Type.String({ pattern: '^[a-f0-9]{64}$' })
const MAX_TOOL_CONTENT = 12000

function memoryToolText(result: unknown): string {
  return JSON.stringify(result, (key, value: unknown) => {
    if (Array.isArray(value) && value.length > 40) return { preview: value.slice(0, 40), truncated: true }
    if (key === 'content' && typeof value === 'string' && value.length > MAX_TOOL_CONTENT) {
      return { preview: value.slice(0, MAX_TOOL_CONTENT), truncated: true }
    }
    return value
  })
}

/** 在主进程固定本轮项目身份；utility 进程仅代理工具输入，不能指定工作区或写权限。 */
export function buildPiMemoryTools(context: PiMemoryContext): ToolDefinition[] {
  if (context.getAccess().source !== 'user') return []
  const service = context.service ?? new AgentMemoryService()
  const targets = new Map<string, MemoryTarget>()
  const scopes = context.workspaceId
    ? [{ kind: 'global' } as const, { kind: 'project', workspaceId: context.workspaceId } as const]
    : [{ kind: 'global' } as const]
  for (const scope of scopes) {
    try { targets.set(scope.kind, service.resolveTarget(scope)) }
    catch (error) { console.warn('[记忆] 当前目标不可用:', error instanceof Error ? error.message : String(error)) }
  }
  if (!targets.size) return []

  const execute = async (raw: unknown, write: boolean, signal?: AbortSignal) => {
    const input = memoryObject(raw)
    if (signal?.aborted || !context.isCurrent()) throw new Error('当前记忆操作已取消或会话归属已改变')
    const access = context.getAccess()
    if (access.source !== 'user') throw new Error('此会话不提供长期记忆工具')
    const target = typeof input.scope === 'string' ? targets.get(input.scope) : undefined
    if (!target) throw new Error('当前会话没有对应记忆目标')
    // Agent 可以在初始化时提交首版正文。沿用 revision 校验，已有文档会返回冲突。
    const action = parseMemoryAction(input.action === 'initialize' && input.content !== undefined
      ? { ...input, action: 'update', expectedRevision: null }
      : input)
    if (isMemoryWrite(action.action) !== write) throw new Error('记忆操作与工具权限不匹配')
    if (write) {
      assertMemoryWriteAccess(access)
      if (target.scope.kind === 'project' && context.beforeProjectFileWrite) {
        const resolved = service.resolveCurrentTarget(target)
        if (!resolved.managed) {
          if (action.action === 'initialize' || action.action === 'update' || action.action === 'archive' || action.action === 'restore') {
            await context.beforeProjectFileWrite(join(resolved.root.path, resolveMemoryFile(resolved, action.path)), signal)
          } else if (action.action === 'linkInstruction') {
            await context.beforeProjectFileWrite(join(resolved.root.path, 'AGENTS.md'), signal)
          }
        }
      }
      if (signal?.aborted || !context.isCurrent()) throw new Error('当前记忆操作已取消或会话归属已改变')
    }
    const result = executeMemoryAction(service, target, action, write ? context.getAccess() : access)
    return { content: [{ type: 'text' as const, text: memoryToolText(result) }], details: {} }
  }

  return [
    {
      name: 'MemoryRead', label: '查询长期记忆',
      description: '只读查询用户明确授权的全局画像和当前项目记忆。可列出文件、检查内容和预算、搜索、读取历史、预览恢复、预览旧记忆导入及项目指令关联。正文截取时使用搜索定位，切勿以预览片段覆盖整个文件。',
      parameters: Type.Object({
        scope: scopeParameter,
        action: Type.Union([Type.Literal('list'), Type.Literal('inspect'), Type.Literal('search'), Type.Literal('history'),
          Type.Literal('restorePreview'), Type.Literal('migrationPreview'), Type.Literal('instructionPreview')]),
        path: pathParameter, query: Type.Optional(Type.String({ maxLength: 200 })), revision: Type.Optional(revisionParameter),
      }),
      execute: async (_id, input, signal) => execute(input, false, signal),
    },
    {
      name: 'MemoryWrite', label: '更新长期记忆',
      description: '依据用户明确提供或验证过的信息维护当前项目记忆或全局画像。initialize 可以通过 content 保存首版正文，已有文件时不得覆盖。更新、归档、恢复必须带当前 expectedRevision，未创建使用 null。迁移必须先预览并提供 planId。关联 AGENTS.md 前先预览其 revision；只有用户要求关联时执行。遇到冲突重新读取并合并。',
      parameters: Type.Object({
        scope: scopeParameter,
        action: Type.Union([Type.Literal('initialize'), Type.Literal('update'), Type.Literal('archive'),
          Type.Literal('restore'), Type.Literal('migrate'), Type.Literal('linkInstruction')]),
        path: pathParameter, revision: Type.Optional(revisionParameter),
        expectedRevision: Type.Optional(Type.Union([revisionParameter, Type.Null()])),
        content: Type.Optional(Type.String({ maxLength: 1024 * 1024 })), planId: Type.Optional(revisionParameter),
      }),
      execute: async (_id, input, signal) => execute(input, true, signal),
    },
  ]
}
