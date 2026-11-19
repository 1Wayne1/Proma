import { isMalformedResponseError, isTransientNetworkError } from '../error-patterns'

import type { NetworkFailureKind } from '@proma/shared'
export type { NetworkFailureKind } from '@proma/shared'

export interface NetworkFailure {
  kind: NetworkFailureKind
  retryable: boolean
  status?: number
}

/** 仅取有限 cause 链用于分类，不把原始错误或凭据存入连接状态。 */
export function classifyNetworkFailure(error: unknown, signal?: AbortSignal): NetworkFailure {
  const messages: string[] = []
  const names: string[] = []
  const codes: string[] = []
  const statuses: number[] = []
  const seen = new Set<unknown>()
  let current = error
  for (let depth = 0; depth < 8 && current !== undefined && !seen.has(current); depth += 1) {
    seen.add(current)
    if (typeof current === 'string') { messages.push(current.slice(0, 4096)); break }
    if (typeof current !== 'object' || current === null) break
    const record = current as Record<string, unknown>
    if (typeof record.message === 'string') messages.push(record.message.slice(0, 4096))
    if (typeof record.name === 'string') names.push(record.name)
    if (typeof record.code === 'string') codes.push(record.code)
    for (const value of [record.status, record.statusCode, record.code]) {
      if (typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 599) statuses.push(value)
    }
    current = record.cause
  }
  const message = messages.join('\n')
  const code = codes.join(' ')
  const status = statuses[0]
  const result = (kind: NetworkFailureKind, retryable = false): NetworkFailure => ({ kind, retryable, ...(status === undefined ? {} : { status }) })

  if (signal?.aborted) {
    const reason: unknown = signal.reason
    if (reason instanceof Error && reason.name === 'TimeoutError') return result('timeout', true)
    return result('cancelled')
  }
  if (names.includes('AbortError') || codes.includes('ABORT_ERR')) return result('cancelled')
  // 拒绝与配置错误必须优先于外层通用的「fetch failed」文案。
  if (statuses.includes(401) || /invalid[_ ]api[_ ]key|invalid_token|unauthorized/i.test(message)) return result('authentication')
  if (statuses.includes(403) || /EACCES|EPERM/.test(code)) return result('permission')
  if (/insufficient_quota|billing[_ ](?:hard[_ ])?limit|quota[_ ]exhausted|credit balance.*(?:low|insufficient)/i.test(message)) return result('quota')
  if (/CERT_|TLS_|SELF_SIGNED|UNABLE_TO_VERIFY|DEPTH_ZERO/i.test(code) || /certificate (?:has expired|verify failed)|self.signed certificate/i.test(message)) return result('tls')
  if (statuses.includes(429)) return result('rate-limit', true)
  if (statuses.includes(408) || names.includes('TimeoutError') || /TIMEOUT|TIMEDOUT/.test(code)) return result('timeout', true)
  if (statuses.some(value => value >= 400 && value < 500)) return result('validation')
  if (statuses.some(value => [500, 502, 503, 504, 524].includes(value))) return result('connection', true)
  if (isTransientNetworkError(message, code) || isMalformedResponseError(message)) return result('connection', true)
  return result('unknown')
}
