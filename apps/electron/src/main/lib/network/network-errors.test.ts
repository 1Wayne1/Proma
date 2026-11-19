import { describe, expect, test } from 'bun:test'
import { classifyNetworkFailure } from './network-errors'

describe('网络失败分类', () => {
  test('Given 外层 fetch failed 与内层认证失败 When 分类 Then 不重试认证错误', () => {
    expect(classifyNetworkFailure(new Error('fetch failed', { cause: { status: 401 } }))).toMatchObject({ kind: 'authentication', retryable: false })
  })
  test.each([
    [{ status: 403, message: 'network error' }, 'permission'],
    [{ status: 429, message: 'insufficient_quota' }, 'quota'],
    [{ status: 400, message: 'fetch failed' }, 'validation'],
    [{ code: 'CERT_HAS_EXPIRED', message: 'fetch failed' }, 'tls'],
    [new DOMException('stopped', 'AbortError'), 'cancelled'],
  ] as const)('Given 不可恢复错误 When 分类 Then 返回永久失败类型', (error, kind) => {
    expect(classifyNetworkFailure(error)).toMatchObject({ kind, retryable: false })
  })
  test.each([
    [{ status: 429 }, 'rate-limit'],
    [{ code: 'UND_ERR_CONNECT_TIMEOUT' }, 'timeout'],
    [{ status: 503 }, 'connection'],
    [{ status: 524 }, 'connection'],
    [new Error('fetch failed', { cause: { code: 'ECONNRESET' } }), 'connection'],
    ['Upstream Responses stream ended before a terminal event', 'connection'],
  ] as const)('Given 瞬时失败 When 分类 Then 允许只读请求恢复', (error, kind) => {
    expect(classifyNetworkFailure(error)).toMatchObject({ kind, retryable: true })
  })
  test('Given 用户取消与超时同时发生 When 分类 Then 用户取消优先', () => {
    const controller = new AbortController()
    controller.abort()
    expect(classifyNetworkFailure({ status: 408 }, controller.signal).kind).toBe('cancelled')
  })
  test('Given 循环 cause 和普通业务错误 When 分类 Then 有界结束且不重试', () => {
    const error: { message: string; cause?: unknown } = { message: 'unknown model' }
    error.cause = error
    expect(classifyNetworkFailure(error)).toEqual({ kind: 'unknown', retryable: false })
  })
})
