/** main 验证后的会话归属；不得直接将 renderer 参数当作已授权项目根。 */
export interface TurnChangeOwner {
  sessionId: string
  turnId: string
  workspaceId: string
}

export type TurnSnapshotOmission = 'too-large' | 'budget-exceeded' | 'unsafe-path' | 'not-file' | 'unreadable' | 'changed-during-read' | 'not-captured'
export type TurnChangeLimitation = 'file-limit' | 'git-output-limit' | 'git-unavailable' | 'git-timeout' | 'git-invalid-path' | 'additional-root-not-captured' | TurnSnapshotOmission

export interface TurnFileSnapshot {
  availability: 'available' | 'missing' | 'omitted'
  /** 完整原始字节的 SHA-256，同时作为私有快照引用；不得是任意磁盘路径。 */
  hash?: string
  byteLength?: number
  format?: 'text' | 'binary'
  reason?: TurnSnapshotOmission
}

export interface TurnFileChange {
  path: string
  kind: 'added' | 'modified' | 'deleted' | 'unknown'
  /** 受控工具捕获也不能证明期间没有外部编辑。 */
  source: 'controlled-tool' | 'git-observed'
  before: TurnFileSnapshot
  after: TurnFileSnapshot
}

export interface TurnChangeLimits {
  maxFiles: number
  maxFileBytes: number
  maxSnapshotBytes: number
  maxGitOutputBytes: number
  gitTimeoutMs: number
}

export interface TurnChangeRecord extends TurnChangeOwner {
  schemaVersion: 1
  recordId: string
  canonicalCwd: string
  startedAt: number
  endedAt: number | null
  completion: 'recording' | 'completed' | 'cancelled' | 'failed'
  partial: boolean
  coverage: {
    mode: 'git-observed' | 'controlled-only'
    /** 非 Git 目录不扫描未知 Shell 或外部写入。 */
    externalWrites: 'observed' | 'not-observed'
  }
  limits: TurnChangeLimits
  limitations: TurnChangeLimitation[]
  files: TurnFileChange[]
}

export interface TurnChangesQuery { sessionId: string; turnId: string }
export interface TurnFileDiffQuery extends TurnChangesQuery { recordId: string; path: string }
export interface TurnDiffSide { snapshot: TurnFileSnapshot; content?: string }
export interface TurnFileDiff { path: string; before: TurnDiffSide; after: TurnDiffSide }

export const TURN_CHANGES_IPC_CHANNELS = {
  LIST: 'turn-changes:list',
  GET_DIFF: 'turn-changes:get-diff',
  CHANGED: 'turn-changes:changed',
  PREVIEW_RESTORE: 'turn-changes:preview-restore',
  APPLY_RESTORE: 'turn-changes:apply-restore',
  REMOVE_WORKTREE: 'turn-changes:remove-worktree',
} as const


/** 恢复仅以主进程签发的短期预览为凭据，不接受写入路径或正文。 */
export interface TurnRestorePreview {
  status: 'ready' | 'conflict' | 'unavailable' | 'busy'
  path: string
  action?: 'write' | 'delete'
  previewId?: string
  expiresAt?: number
  reason?: string
  diff?: TurnFileDiff
  source?: TurnFileChange['source']
}
export interface TurnRestoreApplyInput extends TurnChangesQuery { previewId: string }
export interface TurnRestoreResult {
  status: 'restored' | 'conflict' | 'expired' | 'unavailable' | 'busy' | 'failed'
  path?: string
  reason?: string
}
export interface RemoveWorktreeInput { sessionId: string; worktreePath: string }
export interface RemoveWorktreeResult { path: string; clearedSessionIds: string[]; warnings?: string[] }
