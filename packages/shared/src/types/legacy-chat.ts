/**
 * 旧版 Chat 只读兼容导出与历史查看类型定义
 */

export type LegacyChatSourceStatus = 'available' | 'missing' | 'invalid'

export type LegacyChatSnapshotKind = 'history' | 'tools'

export type LegacyChatArchivedFilter = 'all' | 'active' | 'archived'

/** 本机旧版 Chat 原始数据摘要（严格只读，不包含消息正文或工具凭据） */
export interface LegacyChatSummary {
  scope: 'local-device'
  conversationCount: number
  customToolCount: number
  historyStatus: LegacyChatSourceStatus
  toolsStatus: LegacyChatSourceStatus
}

/** 本机旧版 Chat 对话索引条目 */
export interface LegacyChatHistoryItem {
  id: string
  title: string
  createdAt: number | null
  updatedAt: number | null
  archived: boolean
}

/** 历史 Chat 分页查询参数 */
export interface LegacyChatHistoryQuery {
  query?: string
  archived?: LegacyChatArchivedFilter
  offset?: number
  limit?: number
}

/** 历史 Chat 分页查询结果 */
export interface LegacyChatHistoryPage {
  items: LegacyChatHistoryItem[]
  total: number
  offset: number
  limit: number
  status: LegacyChatSourceStatus
}

/** 为 Agent 工作台准备的旧 Chat 只读快照结果 */
export interface LegacyChatPreparation {
  directory: string
  entryPath: string
  kind: LegacyChatSnapshotKind
  itemCount: number
  warnings: string[]
  conversation?: LegacyChatHistoryItem
}

/** 旧版 Chat 只读兼容 IPC 通道常量 */
export const LEGACY_CHAT_IPC_CHANNELS = {
  /** 获取本机旧版 Chat 数据摘要 */
  GET_SUMMARY: 'legacy-chat:get-summary',
  /** 分页搜索本机旧版历史 Chat 标题列表 */
  LIST_HISTORY: 'legacy-chat:list-history',
  /** 为目标 Agent 会话导出只读不可信快照 */
  PREPARE_SESSION: 'legacy-chat:prepare-session',
} as const
