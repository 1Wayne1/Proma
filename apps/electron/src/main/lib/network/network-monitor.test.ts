import { describe, expect, test } from 'bun:test'
import { NetworkMonitor, checkNetworkOrigin, createObservedFetch, getNetworkProbeOrigin } from './network-monitor'
import type { NetworkFetch } from './network-monitor'

test('Given MCP 连接失败后关闭 When 记录关闭 Then 保留失败分类并拒绝旧连接覆盖重连结果', () => {
  const monitor = new NetworkMonitor()
  const previous = monitor.begin('mcp', 'fixture')
  monitor.finish(previous, { state: 'failed', failureKind: 'authentication' })
  monitor.finish(previous, { state: 'closed' })
  expect(monitor.snapshot().endpoints[0]).toMatchObject({ state: 'closed', failureKind: 'authentication' })
  const current = monitor.begin('mcp', 'fixture')
  monitor.finish(current, { state: 'reachable' })
  monitor.finish(previous, { state: 'closed' })
  expect(monitor.snapshot().endpoints[0]).toMatchObject({ state: 'reachable' })
  expect(monitor.snapshot().endpoints[0]?.failureKind).toBeUndefined()
})

describe('网络状态与匿名诊断', () => {
  test('Given 同一端点并发请求 When 旧请求迟到失败 Then 不覆盖最新成功', () => {
    const monitor = new NetworkMonitor(() => 100)
    const previous = monitor.begin('http', 'https://user:private@example.test/path?token=secret')
    const current = monitor.begin('http', 'https://user:private@example.test/path?token=secret')
    monitor.finish(current, { state: 'reachable', httpStatus: 200 })
    monitor.finish(previous, { state: 'failed', failureKind: 'connection' })
    expect(monitor.snapshot().endpoints[0]?.state).toBe('reachable')
    expect(JSON.stringify(monitor.snapshot())).not.toMatch(/private|secret|example|path|token/)
  })
  test('Given 系统联网提示 When 更新提示 Then 不伪造端点可达性', () => {
    const monitor = new NetworkMonitor()
    expect(monitor.notifyOnline(true)).toMatchObject({ onlineHint: true, endpoints: [] })
  })
  test('Given 超过 32 个连接 When 记录 Then 存储有界且移除订阅后不再回调', () => {
    const monitor = new NetworkMonitor()
    let updates = 0
    const release = monitor.subscribe(() => { updates += 1 })
    for (let i = 0; i < 40; i += 1) monitor.begin('mcp', `server-${i}`)
    expect(monitor.snapshot().endpoints.length).toBe(32)
    release()
    monitor.notifyOnline(false)
    expect(updates).toBe(40)
    const copy = monitor.snapshot()
    copy.endpoints.length = 0
    expect(monitor.snapshot().endpoints.length).toBe(32)
  })
  test('Given 观察者抛错 When 请求完成 Then 不改变请求或 Response 正文', async () => {
    const monitor = new NetworkMonitor()
    monitor.subscribe(() => { throw new Error('subscriber failed') })
    const response = new Response('unconsumed', { status: 401 })
    const fetcher = createObservedFetch(async () => response, monitor)
    expect(await fetcher('https://example.test')).toBe(response)
    expect(await response.text()).toBe('unconsumed')
    expect(monitor.snapshot().endpoints[0]).toMatchObject({ state: 'reachable', httpStatus: 401 })
  })
  test('Given 原始错误含凭据 When 请求失败 Then 原异常不变但诊断只保留分类', async () => {
    const monitor = new NetworkMonitor()
    const error = new Error('fetch failed Authorization: Bearer private-token', { cause: { code: 'ECONNRESET' } })
    const fetcher = createObservedFetch(async () => { throw error }, monitor)
    await expect(fetcher('https://user:password@example.test/secret?api_key=private-key')).rejects.toBe(error)
    expect(JSON.stringify(monitor.snapshot())).not.toMatch(/private|password|api_key|Authorization|example/)
    expect(monitor.snapshot().endpoints[0]?.failureKind).toBe('connection')
  })
  test('Given 带认证路径的地址 When 检查 Then 仅 HEAD origin 且不带认证或跟随跳转', async () => {
    const monitor = new NetworkMonitor()
    const fetcher: NetworkFetch = async (input, init) => {
      expect(input).toBe('https://example.test')
      expect(init).toMatchObject({ method: 'HEAD', credentials: 'omit', redirect: 'manual' })
      expect(init?.headers).toBeUndefined()
      return new Response(null, { status: 302, headers: { location: 'https://other.test/private' } })
    }
    const snapshot = await checkNetworkOrigin('https://user:pass@example.test/path?token=secret#fragment', fetcher, new AbortController().signal, monitor)
    expect(snapshot.endpoints[0]).toMatchObject({ state: 'reachable', httpStatus: 302 })
    expect(getNetworkProbeOrigin('http://localhost:4321/path')).toBe('http://localhost:4321')
    expect(() => getNetworkProbeOrigin('file:///secret')).toThrow()
  })
  test('Given 请求忽略取消 When 用户停止 Then 状态及时结束且迟到响应不覆盖', async () => {
    const monitor = new NetworkMonitor()
    const controller = new AbortController()
    let finish!: (response: Response) => void
    const pending = checkNetworkOrigin('http://localhost', () => new Promise(resolve => { finish = resolve }), controller.signal, monitor)
    controller.abort()
    expect((await pending).endpoints[0]?.state).toBe('cancelled')
    finish(new Response(null, { status: 200 }))
    await Promise.resolve()
    expect(monitor.snapshot().endpoints[0]?.state).toBe('cancelled')
  })
  test('Given 检查超过期限 When TimeoutError 中止 Then 显示超时而非用户取消', async () => {
    const monitor = new NetworkMonitor()
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new DOMException('deadline', 'TimeoutError')), 10)
    try {
      const snapshot = await checkNetworkOrigin('http://localhost', () => new Promise(() => {}), controller.signal, monitor)
      expect(snapshot.endpoints[0]).toMatchObject({ state: 'failed', failureKind: 'timeout' })
    } finally { clearTimeout(timer) }
  })
})
