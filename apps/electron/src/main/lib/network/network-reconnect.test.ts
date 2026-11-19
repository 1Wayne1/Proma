import { describe, expect, test } from 'bun:test'
import { NetworkMonitor } from './network-monitor'
import { NetworkReconnectCoordinator } from './network-reconnect'

describe('显式网络重连协调器', () => {
  test('Given 单次重连正常完成 When 调用 reconnect Then 依次进入 reconnecting 到 ready 且 epoch 递增', async () => {
    const monitor = new NetworkMonitor(() => 1_000)
    const states: Array<{ state?: string; epoch?: number }> = []
    const release = monitor.subscribe((snapshot) => {
      states.push({ state: snapshot.reconnect?.state, epoch: snapshot.reconnect?.epoch })
    })
    let calls = { proxy: 0, browser: 0, mcp: 0 }
    const coordinator = new NetworkReconnectCoordinator({
      monitor,
      refreshProxy: async () => { calls.proxy += 1 },
      reloadBrowserSessions: async () => { calls.browser += 1 },
      reconnectMcp: async () => { calls.mcp += 1 },
    })
    try {
      const snapshot = await coordinator.reconnect(1, 'req-1')
      expect(snapshot.reconnect).toEqual({ epoch: 1, state: 'ready', updatedAt: 1_000 })
      expect(calls).toEqual({ proxy: 1, browser: 1, mcp: 1 })
      expect(states).toEqual([
        { state: 'reconnecting', epoch: 0 },
        { state: 'ready', epoch: 1 },
      ])
    } finally {
      release()
    }
  })

  test('Given 重连进行中 When 并发发起第二次重连 Then 合并到同一次执行并返回相同 ready 快照', async () => {
    const monitor = new NetworkMonitor(() => 2_000)
    let releaseGate!: () => void
    const gate = new Promise<void>((resolve) => { releaseGate = resolve })
    let proxyCalls = 0
    const coordinator = new NetworkReconnectCoordinator({
      monitor,
      refreshProxy: async () => {
        proxyCalls += 1
        await gate
      },
      reloadBrowserSessions: async () => {},
      reconnectMcp: async () => {},
    })

    const first = coordinator.reconnect(1, 'first')
    const second = coordinator.reconnect(1, 'second')
    releaseGate()

    const [a, b] = await Promise.all([first, second])
    expect(proxyCalls).toBe(1)
    expect(a.reconnect).toEqual({ epoch: 1, state: 'ready', updatedAt: 2_000 })
    expect(b.reconnect).toEqual({ epoch: 1, state: 'ready', updatedAt: 2_000 })
  })

  test('Given 两个合并等待者 When 误用 requestId 或其他 owner 取消无效 且 仅取消一个等待者 Then 另一个仍成功', async () => {
    const monitor = new NetworkMonitor(() => 3_000)
    let releaseGate!: () => void
    const gate = new Promise<void>((resolve) => { releaseGate = resolve })
    const coordinator = new NetworkReconnectCoordinator({
      monitor,
      refreshProxy: async () => { await gate },
      reloadBrowserSessions: async () => {},
      reconnectMcp: async () => {},
    })

    const first = coordinator.reconnect(1, 'first')
    const second = coordinator.reconnect(1, 'second')

    expect(coordinator.cancel(2, 'first')).toBe(false)
    expect(coordinator.cancel(1, 'wrong-id')).toBe(false)
    expect(coordinator.cancel(1, 'first')).toBe(true)

    await expect(first).rejects.toHaveProperty('name', 'AbortError')
    releaseGate()
    const snapshot = await second
    expect(snapshot.reconnect).toEqual({ epoch: 1, state: 'ready', updatedAt: 3_000 })
  })

  test('Given 唯一等待者且底层忽略取消信号 When 取消重连 Then 立即返回 cancelled 且迟到完成不覆盖并在后续可重新成功', async () => {
    const monitor = new NetworkMonitor(() => 4_000)
    let finishSlow!: () => void
    let started!: () => void
    const firstStarted = new Promise<void>((resolve) => { started = resolve })
    let attempt = 0
    const coordinator = new NetworkReconnectCoordinator({
      monitor,
      refreshProxy: async () => {
        attempt += 1
        if (attempt === 1) {
          started()
          await new Promise<void>((resolve) => { finishSlow = resolve })
        }
      },
      reloadBrowserSessions: async () => {},
      reconnectMcp: async () => {},
    })

    const pending = coordinator.reconnect(1, 'only-one')
    await firstStarted
    expect(coordinator.cancel(1, 'only-one')).toBe(true)

    const cancelledSnapshot = await pending
    expect(cancelledSnapshot.reconnect).toEqual({
      epoch: 0,
      state: 'cancelled',
      failureKind: 'cancelled',
      updatedAt: 4_000,
    })

    // 迟到的第一轮底层完成不应覆写 cancelled 或错误递增 epoch。
    finishSlow()
    await Promise.resolve()
    await Promise.resolve()
    expect(monitor.snapshot().reconnect).toEqual({
      epoch: 0,
      state: 'cancelled',
      failureKind: 'cancelled',
      updatedAt: 4_000,
    })

    const next = await coordinator.reconnect(1, 'second-try')
    expect(next.reconnect).toEqual({ epoch: 1, state: 'ready', updatedAt: 4_000 })
  })

  test('Given 底层步骤超过期限 When 超时 Then 返回 failed 与 timeout 分类且 epoch 不递增', async () => {
    const monitor = new NetworkMonitor(() => 5_000)
    const coordinator = new NetworkReconnectCoordinator({
      monitor,
      timeoutMs: 25,
      refreshProxy: async () => new Promise<void>(() => {}),
      reloadBrowserSessions: async () => {},
      reconnectMcp: async () => {},
    })

    const snapshot = await coordinator.reconnect(1, 'timeout-req')
    expect(snapshot.reconnect).toEqual({
      epoch: 0,
      state: 'failed',
      failureKind: 'timeout',
      updatedAt: 5_000,
    })
  })

  test('Given 底层步骤抛出含敏感凭据的错误 When 重连失败 Then 返回脱敏 failed 快照', async () => {
    const monitor = new NetworkMonitor(() => 6_000)
    const coordinator = new NetworkReconnectCoordinator({
      monitor,
      refreshProxy: async () => {
        throw new Error('Authorization: Bearer secret-token-value ECONNRESET', {
          cause: { code: 'ECONNRESET' },
        })
      },
      reloadBrowserSessions: async () => {},
      reconnectMcp: async () => {},
    })

    const snapshot = await coordinator.reconnect(1, 'secret-err')
    expect(snapshot.reconnect).toEqual({
      epoch: 0,
      state: 'failed',
      failureKind: 'connection',
      updatedAt: 6_000,
    })
    expect(JSON.stringify(snapshot)).not.toMatch(/secret-token-value|Authorization|ECONNRESET/)
  })

  test('Given 调用方信号已预先取消 When 调用 reconnect Then 立即拒绝且不执行任何依赖', async () => {
    const monitor = new NetworkMonitor(() => 7_000)
    let called = false
    const coordinator = new NetworkReconnectCoordinator({
      monitor,
      refreshProxy: async () => { called = true },
      reloadBrowserSessions: async () => { called = true },
      reconnectMcp: async () => { called = true },
    })

    const controller = new AbortController()
    controller.abort()
    await expect(coordinator.reconnect(1, 'pre-aborted', controller.signal)).rejects.toHaveProperty('name', 'AbortError')
    expect(called).toBe(false)
    expect(monitor.snapshot().reconnect).toBeUndefined()
  })

  test('Given 进行中调用方 ownerSignal 中止 When 唯一等待者中止 Then 拒绝该等待者并使状态收敛为 cancelled', async () => {
    const monitor = new NetworkMonitor(() => 7_500)
    let started!: () => void
    const waitStarted = new Promise<void>((resolve) => { started = resolve })
    const coordinator = new NetworkReconnectCoordinator({
      monitor,
      refreshProxy: async () => {
        started()
        await new Promise<void>(() => {})
      },
      reloadBrowserSessions: async () => {},
      reconnectMcp: async () => {},
    })

    const controller = new AbortController()
    const pending = coordinator.reconnect(1, 'owner-abort', controller.signal)
    await waitStarted
    controller.abort()
    await expect(pending).rejects.toHaveProperty('name', 'AbortError')
    expect(monitor.snapshot().reconnect).toEqual({
      epoch: 0,
      state: 'cancelled',
      failureKind: 'cancelled',
      updatedAt: 7_500,
    })
  })

  test('Given 存在进行中的重连 When 调用 cancelAll Then 全部收敛为 cancelled 且不留存未完成任务', async () => {
    const monitor = new NetworkMonitor(() => 8_000)
    let started!: () => void
    const waitStarted = new Promise<void>((resolve) => { started = resolve })
    const coordinator = new NetworkReconnectCoordinator({
      monitor,
      refreshProxy: async () => {
        started()
        await new Promise<void>(() => {})
      },
      reloadBrowserSessions: async () => {},
      reconnectMcp: async () => {},
    })

    const pending = coordinator.reconnect(1, 'quit-req')
    await waitStarted
    coordinator.cancelAll()

    const snapshot = await pending
    expect(snapshot.reconnect).toEqual({
      epoch: 0,
      state: 'cancelled',
      failureKind: 'cancelled',
      updatedAt: 8_000,
    })
  })
})
