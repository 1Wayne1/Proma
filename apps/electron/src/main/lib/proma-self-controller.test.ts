import { describe, expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import type { BrowserWindow } from 'electron'
import { PromaSelfController } from './proma-self-controller'
import type { PromaSelfAction, PromaSelfExecution } from './proma-self-control-policy'

const entryUrl = 'file:///proma/renderer/index.html'
const user: PromaSelfExecution = { sessionId: 'user-session', source: 'user', isCurrent: () => true }
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aLc0AAAAASUVORK5CYII='

function fixture() {
  const contents = new EventEmitter()
  const debuggerClient = new EventEmitter()
  const clicks: string[] = []
  const actions: { id: string; action: PromaSelfAction }[] = []
  const screenshotExpressions: string[] = []
  const selectors: string[] = []
  const controls = new Map<string, { nodeIds: number[]; available: boolean }>([
    ['open-todos', { nodeIds: [2], available: true }],
    ['open-calendar', { nodeIds: [3], available: true }],
  ])
  let attached = false
  let url = entryUrl
  let now = 0
  let waitForFrame: (() => Promise<void>) | undefined
  let onQuery: (() => void) | undefined
  let screenshot: string = png
  const window = {
    isDestroyed: () => false,
    webContents: Object.assign(contents, {
      isDestroyed: () => false,
      isLoadingMainFrame: () => false,
      getURL: () => url,
      debugger: Object.assign(debuggerClient, {
        isAttached: () => attached,
        attach: () => { attached = true },
        detach: () => { attached = false; debuggerClient.emit('detach') },
        async sendCommand(method: string, params?: Record<string, unknown>): Promise<unknown> {
          switch (method) {
            case 'Page.getFrameTree': await waitForFrame?.(); return { frameTree: { frame: { id: 'main' } } }
            case 'Page.createIsolatedWorld': return { executionContextId: 1 }
            case 'DOM.getDocument': return { root: { nodeId: 1 } }
            case 'DOM.querySelectorAll': {
              onQuery?.()
              const selector = String(params?.selector)
              selectors.push(selector)
              const id = selector.match(/\[data-proma-self-control="([a-z-]+)"\]$/)?.[1] ?? ''
              return { nodeIds: controls.get(id)?.nodeIds ?? [] }
            }
            case 'DOM.describeNode': return { node: { backendNodeId: params?.nodeId } }
            case 'DOM.resolveNode': return { object: { objectId: String(params?.backendNodeId) } }
            case 'Runtime.callFunctionOn': {
              const args = params?.arguments as Array<{ value: unknown }>
              const id = String(args[0]?.value)
              const control = controls.get(id)
              const available = control?.available && control.nodeIds.includes(Number(params?.objectId))
              if (!available) return { result: { value: false } }
              const action = args[2]?.value as PromaSelfAction | null
              if (action) {
                if (action.type === 'click') clicks.push(id)
                actions.push({ id, action })
              }
              return { result: { value: action ? true : { x: 10, y: 30, width: 120, height: 30, secret: '不导出额外属性' } } }
            }
            case 'Runtime.evaluate': {
              screenshotExpressions.push(String(params?.expression))
              return { result: { value: screenshot } }
            }
            default: throw new Error(`夹具没有收到预期的 CDP 指令：${method}`)
          }
        },
      }),
    }),
  } as unknown as BrowserWindow
  let alive = true
  const controller = new PromaSelfController(() => alive ? { window, entryUrl } : null, () => now)
  return {
    controller, contents, controls, clicks, actions, selectors, screenshotExpressions, isAttached: () => attached,
    setUrl: (next: string) => { url = next },
    setNow: (next: number) => { now = next },
    close: () => { alive = false; contents.emit('destroyed') },
    blockFrame: (wait: () => Promise<void>) => { waitForFrame = wait },
    setOnQuery: (callback: () => void) => { onQuery = callback },
    setScreenshot: (next: string) => { screenshot = next },
  }
}

describe('Proma 自身界面控制器', () => {
  test('Given 主窗口提供安全导航 When 观察并点击 Then 仅返回静态标签且引用只能使用一次', async () => {
    const { controller, clicks, selectors, isAttached } = fixture()
    const observed = await controller.observe(user)
    expect(observed.controls.map(({ id, label }) => ({ id, label }))).toEqual([
      { id: 'open-todos', label: 'Todo' }, { id: 'open-calendar', label: '日程' },
    ])
    expect(selectors).toEqual([
      'button[data-proma-self-control="open-todos"]', 'button[data-proma-self-control="open-calendar"]',
      'input[data-proma-self-control="file-search"]', 'div[data-proma-self-control="scroll-project-files"]',
      'div[data-proma-self-control="scroll-session-files"]',
    ])
    const reference = observed.controls[0]!.reference
    await controller.click(user, observed.generation, reference)
    expect(clicks).toEqual(['open-todos'])
    await expect(controller.click(user, observed.generation, reference)).rejects.toThrow('引用已失效')
    expect(isAttached()).toBe(false)
  })

  test('Given 两次观察或主框架重载 When 使用旧引用 Then 拒绝且不点击', async () => {
    const { controller, contents, clicks } = fixture()
    const first = await controller.observe(user)
    const second = await controller.find(user, '日程')
    expect(second.controls.map(control => control.id)).toEqual(['open-calendar'])
    await expect(controller.click(user, first.generation, first.controls[0]!.reference)).rejects.toThrow('引用已失效')
    const third = await controller.find(user, 'Todo')
    contents.emit('did-start-navigation', { isMainFrame: false })
    await controller.click(user, third.generation, third.controls[0]!.reference)
    const fourth = await controller.observe(user)
    contents.emit('did-start-navigation', { isMainFrame: true })
    await expect(controller.click(user, fourth.generation, fourth.controls[0]!.reference)).rejects.toThrow('引用已失效')
    expect(clicks).toEqual(['open-todos'])
  })

  test('Given 观察后控件被替换或出现歧义 When 操作 Then 不替换目标也不猜测', async () => {
    const { controller, controls, clicks } = fixture()
    const observed = await controller.find(user, 'Todo')
    controls.set('open-todos', { nodeIds: [4], available: true })
    await expect(controller.click(user, observed.generation, observed.controls[0]!.reference)).rejects.toThrow('不可操作')
    controls.set('open-todos', { nodeIds: [4, 5], available: true })
    expect((await controller.find(user, 'Todo')).controls).toEqual([])
    expect((await controller.find(user, '权限确认')).controls).toEqual([])
    expect(clicks).toEqual([])
  })

  test('Given 非交互来源、其他会话或过期引用 When 操作 Then 拒绝访问', async () => {
    const { controller, setNow, clicks } = fixture()
    for (const source of ['automation', 'delegation', 'external'] as const) {
      await expect(controller.observe({ ...user, source })).rejects.toThrow('仅供当前用户交互会话')
    }
    const observed = await controller.observe(user)
    await expect(controller.click({ ...user, sessionId: 'other' }, observed.generation, observed.controls[0]!.reference)).rejects.toThrow('引用已失效')
    const fresh = await controller.observe(user)
    setNow(60_000)
    await expect(controller.click(user, fresh.generation, fresh.controls[0]!.reference)).rejects.toThrow('引用已失效')
    expect(clicks).toEqual([])
  })

  test('Given 主窗口切换到未登记 URL 或已关闭 When 观察 Then 不连接调试器', async () => {
    const { controller, setUrl, close, selectors, isAttached } = fixture()
    setUrl('https://example.test/')
    await expect(controller.observe(user)).rejects.toThrow('不在已登记的页面')
    close()
    await expect(controller.observe(user)).rejects.toThrow('主窗口不可用')
    expect(selectors).toEqual([])
    expect(isAttached()).toBe(false)
  })

  test('Given 同一会话开始新一轮 When 复用上一轮控件引用 Then 拒绝动作', async () => {
    const { controller, clicks } = fixture()
    const firstRun = { ...user, observationOwner: {} }
    const nextRun = { ...user, observationOwner: {} }
    const observation = await controller.observe(firstRun)
    await expect(controller.click(nextRun, observation.generation, observation.controls[0]!.reference)).rejects.toThrow('引用已失效')
    expect(clicks).toEqual([])
  })

  test('Given 操作仍在等待 CDP When 重入并取消 Then 拒绝重入且迟到响应不点击', async () => {
    const { controller, blockFrame, clicks, selectors, isAttached } = fixture()
    const observed = await controller.find(user, 'Todo')
    const abort = new AbortController()
    const entered = Promise.withResolvers<void>()
    const response = Promise.withResolvers<void>()
    blockFrame(() => { entered.resolve(); return response.promise })
    const pending = controller.click({ ...user, signal: abort.signal }, observed.generation, observed.controls[0]!.reference)
    await entered.promise
    await expect(controller.observe(user)).rejects.toThrow('正在执行')
    abort.abort()
    await expect(pending).rejects.toThrow('已停止')
    response.resolve()
    expect(clicks).toEqual([])
    expect(selectors).toEqual(['button[data-proma-self-control="open-todos"]'])
    expect(isAttached()).toBe(false)
  })

  test('Given 文件搜索与滚动区已授权 When 填写、按键和滚动 Then 每项只向对应控件投递一次', async () => {
    const { controller, controls, actions } = fixture()
    controls.set('file-search', { nodeIds: [4], available: true })
    controls.set('scroll-project-files', { nodeIds: [5], available: true })
    const text = await controller.find(user, '搜索文件')
    expect(text.controls[0]?.actions).toEqual(['fill', 'press'])
    await controller.fill(user, text.generation, text.controls[0]!.reference, '示例文件')
    const keys = await controller.find(user, '搜索文件')
    await controller.press(user, keys.generation, keys.controls[0]!.reference, 'ArrowDown')
    const list = await controller.find(user, '滚动项目文件')
    await controller.scroll(user, list.generation, list.controls[0]!.reference, 320)
    expect(actions).toEqual([
      { id: 'file-search', action: { type: 'fill', value: '示例文件' } },
      { id: 'file-search', action: { type: 'press', value: 'ArrowDown' } },
      { id: 'scroll-project-files', action: { type: 'scroll', value: 320 } },
    ])
  })

  test('Given 受保护的键、输入或不匹配的控件 When 操作 Then 不发出任何动作', async () => {
    const { controller, controls, actions } = fixture()
    controls.set('file-search', { nodeIds: [4], available: true })
    const search = await controller.find(user, '搜索文件')
    const reference = search.controls[0]!.reference
    expect(() => controller.press(user, search.generation, reference, 'Enter')).toThrow('只允许搜索结果导航键')
    expect(() => controller.press(user, search.generation, reference, 'Meta+Shift+T')).toThrow('只允许搜索结果导航键')
    expect(() => controller.fill(user, search.generation, reference, '行一\n行二')).toThrow('单行文本')
    expect(() => controller.scroll(user, search.generation, reference, 1201)).toThrow('滚动距离')
    await expect(controller.scroll(user, search.generation, reference, 160)).rejects.toThrow('未授权')
    const button = await controller.find(user, 'Todo')
    await expect(controller.fill(user, button.generation, button.controls[0]!.reference, '不应写入')).rejects.toThrow('未授权')
    expect(actions).toEqual([])
  })

  test('Given 授权文件搜索暂不可见 When 等待后出现 Then 返回可用的新引用', async () => {
    const { controller, controls, setOnQuery, selectors } = fixture()
    setOnQuery(() => {
      if (selectors.length > 0) controls.set('file-search', { nodeIds: [4], available: true })
    })
    const result = await controller.waitFor(user, 'file-search', 500)
    expect(result.controls.map(control => control.id)).toEqual(['file-search'])
    expect(selectors).toHaveLength(2)
  })

  test('Given 等待的目标持续隐藏 When 超时或取消 Then 不返回引用并释放 CDP', async () => {
    const { controller, setOnQuery, actions, isAttached } = fixture()
    await expect(controller.waitFor(user, 'file-search', 10)).rejects.toThrow('超时')
    expect(() => controller.waitFor(user, '密码框')).toThrow('已授权的控件')
    const scanned = Promise.withResolvers<void>()
    setOnQuery(() => scanned.resolve())
    const abort = new AbortController()
    const waiting = controller.waitFor({ ...user, signal: abort.signal }, 'file-search')
    await scanned.promise
    abort.abort()
    await expect(waiting).rejects.toThrow()
    expect(actions).toEqual([])
    expect(isAttached()).toBe(false)
  })

  test('Given 中间动作带有私密值 When 截图 Then 只把可信布局和静态标签传给栅格化代码', async () => {
    const { controller, controls, screenshotExpressions, setScreenshot } = fixture()
    controls.set('file-search', { nodeIds: [4], available: true })
    const first = await controller.find(user, '搜索文件')
    await controller.fill(user, first.generation, first.controls[0]!.reference, '禁止泄漏的验收记号')
    const observed = await controller.find(user, 'Todo')
    const image = await controller.screenshot(user)
    expect(image).toMatchObject({ mimeType: 'image/png', width: 1, height: 1, redacted: true })
    expect(screenshotExpressions[0]).toContain('搜索文件')
    expect(screenshotExpressions[0]).not.toContain('禁止泄漏的验收记号')
    expect(screenshotExpressions[0]).not.toContain('不导出额外属性')
    expect(screenshotExpressions[0]).not.toContain('drawImage')
    await expect(controller.click(user, observed.generation, observed.controls[0]!.reference)).rejects.toThrow('引用已失效')
    setScreenshot('data:image/png;base64,bm90LWEtcG5n')
    await expect(controller.screenshot(user)).rejects.toThrow('格式无效')
  })
})
