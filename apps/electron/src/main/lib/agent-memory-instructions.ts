import { lstatSync } from 'node:fs'
import { join } from 'node:path'
import type { MemoryInstructionLink, MemoryTarget, MemoryWriteAccess } from '@proma/shared'
import { assertMemoryRoots, assertMemoryWriteAccess } from './agent-memory'
import type { AgentMemoryService } from './agent-memory'
import { resolveProjectInstructions } from './project-instruction-resolver'
import { isMissingTurnFile } from './turn-changes/paths'
import { commitRestoreFile, inspectRestoreFile } from './turn-changes/restore-files'

const MAX_INSTRUCTION_BYTES = 64 * 1024

function readInstruction(service: AgentMemoryService, target: MemoryTarget) {
  if (target.scope.kind !== 'project') throw new Error('只可为项目记忆关联 AGENTS.md')
  const resolved = service.resolveCurrentTarget(target)
  if (service.inspect(target).revision === null) throw new Error('请先创建项目记忆索引')
  const file = resolveProjectInstructions({ projectRoot: resolved.root.path }).sources.find((source) => source.kind === 'agents' && source.scopeRoot === '.')
  // 优先遵从现有项目指令的文件名；绝不将 CLAUDE.md 当作目标。
  let path = file?.relativePath ?? 'AGENTS.md'
  if (!file) {
    for (const candidate of ['AGENTS.md', 'AGENTS.MD']) {
      try { lstatSync(join(resolved.root.path, candidate)); path = candidate; break }
      catch (error) { if (!isMissingTurnFile(error)) throw error }
    }
  }
  const state = inspectRestoreFile(resolved.root.path, path, MAX_INSTRUCTION_BYTES)
  if (state.snapshot.format === 'binary') throw new Error('AGENTS.md 必须是 UTF-8 文本')
  const content = state.bytes?.toString('utf8') ?? ''
  const link = resolved.managed ? 'memory/MEMORY.md' : 'MEMORY.md'
  const linked = content.includes(`](${link})`) || content.includes(`](./${link})`)
  const revision = state.snapshot.hash ?? null
  assertMemoryRoots(resolved)
  return { resolved, state, content, link, info: { path, revision, linked } satisfies MemoryInstructionLink }
}

export function previewMemoryInstruction(service: AgentMemoryService, target: MemoryTarget): MemoryInstructionLink {
  return readInstruction(service, target).info
}

export function linkMemoryInstruction(service: AgentMemoryService, target: MemoryTarget, access: MemoryWriteAccess, expectedRevision: string | null): MemoryInstructionLink {
  assertMemoryWriteAccess(access)
  const { resolved, state, content, link, info } = readInstruction(service, target)
  if (info.revision !== expectedRevision) throw new Error('项目指令已变化，请重新预览')
  if (info.linked) return info
  const newline = content.includes('\r\n') ? '\r\n' : '\n'
  const gap = !content || content.endsWith(newline + newline) ? '' : content.endsWith(newline) ? newline : newline + newline
  const next = Buffer.from(`${content}${gap}- [项目记忆](${link})${newline}`)
  if (next.length > MAX_INSTRUCTION_BYTES) throw new Error('关联后项目指令将超过 64 KiB')
  commitRestoreFile(resolved.root.path, info.path, state, next, MAX_INSTRUCTION_BYTES, () => {
    assertMemoryRoots(resolved)
    service.resolveCurrentTarget(target)
  })
  return previewMemoryInstruction(service, target)
}
