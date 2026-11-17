import { describe, expect, test } from 'bun:test'
import { runWithNetworkRecovery, waitForNetworkOperation, withNetworkAbortSignal } from './network-recovery'

describe('有限网络恢复', () => {
  test('Given 只读操作第一次断线 When 恢复 Then 在同一次调用内成功', async () => {
    let calls = 0
    const result = await runWithNetworkRecovery(async () => {
      calls += 1
      if (calls === 1) throw new Error('ECONNRESET')
      return 'tools'
    }, { replay: 'read-only', baseDelayMs: 0 })
    expect(result).toBe('tools')
    expect(calls).toBe(2)
  })
  test('Given 操作有副作用 When 网络失败 Then 不重放', async () => {
    let calls = 0
    await expect(runWithNetworkRecovery(async () => {
      calls += 1
      throw new Error('ECONNRESET')
    }, { replay: 'never' })).rejects.toThrow('ECONNRESET')
    expect(calls).toBe(1)
  })
  test('Given 持续断线 When 达到次数上限 Then 返回原错误', async () => {
    let calls = 0
    const error = new Error('fetch failed')
    await expect(runWithNetworkRecovery(async () => { calls += 1; throw error }, { replay: 'read-only', maxAttempts: 2, baseDelayMs: 0 })).rejects.toBe(error)
    expect(calls).toBe(2)
  })
  test('Given 认证失败 When 恢复只读操作 Then 不等待或重试', async () => {
    let calls = 0
    await expect(runWithNetworkRecovery(async () => { calls += 1; throw { status: 401 } }, { replay: 'read-only' })).rejects.toEqual({ status: 401 })
    expect(calls).toBe(1)
  })
  test('Given 退避期间取消 When 等待中止 Then 不发送下一次请求', async () => {
    const controller = new AbortController()
    let calls = 0
    const result = runWithNetworkRecovery(async () => {
      calls += 1
      queueMicrotask(() => controller.abort())
      throw new Error('ECONNRESET')
    }, { replay: 'read-only', baseDelayMs: 30_000, signal: controller.signal })
    await expect(result).rejects.toHaveProperty('name', 'AbortError')
    expect(calls).toBe(1)
  })
  test('Given 已取消 When 开始恢复 Then 不调用 operation', async () => {
    const controller = new AbortController()
    controller.abort()
    let calls = 0
    await expect(runWithNetworkRecovery(async () => { calls += 1 }, { replay: 'read-only', signal: controller.signal })).rejects.toHaveProperty('name', 'AbortError')
    expect(calls).toBe(0)
  })
  test('Given 请求忽略 signal 并迟到成功 When 用户已取消 Then 不交付成功结果', async () => {
    const controller = new AbortController()
    await expect(runWithNetworkRecovery(async () => { controller.abort(); return 'late' }, { replay: 'read-only', signal: controller.signal })).rejects.toHaveProperty('name', 'AbortError')
  })
  test('Given 非法预算 When 开始恢复 Then 不执行请求', async () => {
    await expect(runWithNetworkRecovery(async () => 'unused', { replay: 'read-only', maxAttempts: Number.NaN })).rejects.toThrow(RangeError)
    await expect(runWithNetworkRecovery(async () => 'unused', { replay: 'read-only', baseDelayMs: -1 })).rejects.toThrow(RangeError)
  })
  test('Given 共享操作尚未完成 When 等待者取消 Then 立即结束等待并允许原操作完成', async () => {
    let finish!: (value: string) => void
    const shared = new Promise<string>(resolve => { finish = resolve })
    const controller = new AbortController()
    const waiting = waitForNetworkOperation(shared, controller.signal)
    controller.abort(new Error('用户停止'))
    await expect(waiting).rejects.toThrow('用户停止')
    finish('shared-result')
    await expect(shared).resolves.toBe('shared-result')
  })
  test('Given 多个取消来源 When 操作已完成 Then 后续取消不再传递到结束的作用域', async () => {
    const first = new AbortController()
    const second = new AbortController()
    let completedSignal: AbortSignal | undefined
    await withNetworkAbortSignal([first.signal, second.signal], async signal => { completedSignal = signal })
    first.abort()
    second.abort()
    expect(completedSignal?.aborted).toBe(false)
  })
  test('Given 组合信号作用域等待未完成请求 When 来源取消 Then 立即拒绝', async () => {
    const controller = new AbortController()
    const waiting = withNetworkAbortSignal([controller.signal], signal => waitForNetworkOperation(new Promise<void>(() => {}), signal))
    controller.abort()
    await expect(waiting).rejects.toHaveProperty('name', 'AbortError')
  })
})
