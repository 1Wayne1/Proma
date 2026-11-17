export type NetworkFailureKind =
  | 'cancelled' | 'authentication' | 'permission' | 'quota' | 'validation'
  | 'tls' | 'rate-limit' | 'timeout' | 'connection' | 'unknown'

export type NetworkSource = 'http' | 'mcp' | 'probe'
export type NetworkEndpointState = 'checking' | 'reachable' | 'failed' | 'closed' | 'cancelled'

export interface NetworkEndpointStatus {
  /** 匿名连接标识，不携带地址、渠道名、工具参数或凭据。 */
  id: string
  source: NetworkSource
  state: NetworkEndpointState
  updatedAt: number
  httpStatus?: number
  failureKind?: NetworkFailureKind
}

export interface NetworkStatusSnapshot {
  revision: number
  onlineHint: boolean | null
  endpoints: NetworkEndpointStatus[]
}

export interface NetworkCheckInput {
  requestId: string
  channelId: string
}

export interface NetworkDiagnosticReport {
  schemaVersion: 1
  generatedAt: number
  scope: 'main-process-http-and-mcp'
  snapshot: NetworkStatusSnapshot
}

export interface NetworkDiagnosticPreview {
  previewId: string
  report: NetworkDiagnosticReport
}

export interface NetworkDiagnosticExportResult {
  status: 'saved' | 'cancelled'
}

export const NETWORK_IPC_CHANNELS = {
  GET_STATUS: 'network:get-status',
  NOTIFY_ONLINE: 'network:notify-online',
  STATUS_CHANGED: 'network:status-changed',
  CHECK: 'network:check',
  CANCEL_CHECK: 'network:cancel-check',
  PREVIEW_DIAGNOSTICS: 'network:diagnostics-preview',
  EXPORT_DIAGNOSTICS: 'network:diagnostics-export',
} as const
