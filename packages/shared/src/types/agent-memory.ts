import type { PromaPermissionMode } from './agent'

export const AGENT_MEMORY_IPC_CHANNEL = 'agent-memory:request'

export type MemoryScope = { kind: 'global' } | { kind: 'project'; workspaceId: string }

export interface MemoryTarget {
  id: string
  scope: MemoryScope
}

export interface MemoryUsage {
  used: number
  limit: number
}

export interface MemoryDocument {
  content: string | null
  revision: string | null
  usage?: MemoryUsage
}

export interface MemoryWriteAccess {
  source: 'user' | 'automation' | 'delegation' | 'external'
  permissionMode: PromaPermissionMode
  readOnly?: boolean
}

export type MemoryWriteResult =
  | { status: 'saved' | 'unchanged'; document: MemoryDocument }
  | { status: 'conflict'; currentRevision: string | null }
  | { status: 'over-budget'; usage: MemoryUsage }

export interface MemoryHistoryEntry {
  revision: string
  savedAt: number
}

export interface MemoryFileList {
  files: string[]
  archived: string[]
  partial: boolean
}

export interface MemorySearchResult {
  hits: Array<{ path: string; line: number; snippet: string }>
  partial: boolean
}

export interface MemoryRestorePreview {
  current: MemoryDocument
  archived: MemoryDocument
}

export type MemoryMigrationStatus = 'ready' | 'conflict' | 'present' | 'unsupported' | 'imported' | 'failed'

export interface MemoryMigrationItem {
  source: string
  path?: string
  revision?: string
  status: MemoryMigrationStatus
  reason?: string
}

export interface MemoryMigrationPlan {
  id: string
  items: MemoryMigrationItem[]
  partial: boolean
}

export interface MemoryInstructionLink {
  path: string
  revision: string | null
  linked: boolean
}

type MemoryFileRequest =
  | { action: 'inspect' | 'initialize' | 'history'; path?: string }
  | { action: 'update'; path?: string; expectedRevision: string | null; content: string }
  | { action: 'archive'; path?: string; expectedRevision: string | null }
  | { action: 'restorePreview'; path?: string; revision: string }
  | { action: 'restore'; path?: string; revision: string; expectedRevision: string | null }

export type MemoryAction =
  | MemoryFileRequest
  | { action: 'list' }
  | { action: 'search'; query: string }
  | { action: 'migrationPreview' }
  | { action: 'migrate'; planId: string }
  | { action: 'instructionPreview' }
  | { action: 'linkInstruction'; expectedRevision: string | null }

export type AgentMemoryRequest = { action: 'target'; scope: MemoryScope } | (MemoryAction & { target: MemoryTarget })

export interface AgentMemoryReplies {
  target: MemoryTarget
  list: MemoryFileList
  inspect: MemoryDocument
  initialize: MemoryWriteResult
  update: MemoryWriteResult
  archive: MemoryWriteResult
  history: MemoryHistoryEntry[]
  restorePreview: MemoryRestorePreview
  restore: MemoryWriteResult
  search: MemorySearchResult
  migrationPreview: MemoryMigrationPlan
  migrate: MemoryMigrationPlan
  instructionPreview: MemoryInstructionLink
  linkInstruction: MemoryInstructionLink
}
