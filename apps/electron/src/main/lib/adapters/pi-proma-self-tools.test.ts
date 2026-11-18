import { describe, expect, test } from 'bun:test'
import { setTimeout as delay } from 'node:timers/promises'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import { buildPiPromaSelfTools } from './pi-proma-self-tools'
import { PromaSelfForegroundSessions } from '../proma-self-access'
import type { PromaSelfExecution } from '../proma-self-control-policy'

const sessionId = 'test-session'
const origin = { sessionId, trustedMainFrame: true, hasAutomationContext: false }
const observation = { generation: 'generation', controls: [] }
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRfcAAAAASUVORK5CYII='
const unusedContext = {} as Parameters<ToolDefinition['execute']>[4]

function createFixture() {
  const target = {}
  const foreground = new PromaSelfForegroundSessions<object>()
  foreground.set(target, sessionId)
  const grant = foreground.grant(target, origin, () => true)!
  const access = { sessionId, ...grant }
  const controller = {
    observe: async () => observation,
    find: async () => observation,
    click: async () => {},
    fill: async () => {},
    press: async () => {},
    scroll: async () => {},
    waitFor: async () => observation,
    screenshot: async () => ({ mimeType: 'image/png' as const, base64: png, width: 1, height: 1, redacted: true as const }),
  }
  return { target, foreground, access, controller }
}

describe('Pi Proma 自身界面工具', () => {
  test('Given 当前主窗口的交互运行 When Pi 注册工具并截图 Then 只返回会话 PNG 和简短说明', async () => {
    const { access, controller } = createFixture()
    const tools = buildPiPromaSelfTools(access, controller)
    expect(tools.map(tool => tool.name)).toEqual([
      'PromaSelfObserve', 'PromaSelfFind', 'PromaSelfClick', 'PromaSelfFill', 'PromaSelfPress',
      'PromaSelfScroll', 'PromaSelfWaitFor', 'PromaSelfScreenshot',
    ])
    const screenshot = tools.at(-1)!
    const result = await screenshot.execute('call', {}, undefined, undefined, unusedContext)
    expect(result.content).toEqual([
      { type: 'text', text: '已交付 Proma 脱敏截图（1 × 1）' },
      { type: 'image', mimeType: 'image/png', data: png },
    ])
    expect(result.details).toEqual({})
    await expect(screenshot.execute('call', { url: 'https://example.invalid' }, undefined, undefined, unusedContext)).rejects.toThrow('参数无效')
  })

  test('Given 后台来源、非主框架或不可见会话 When 构建 Pi 工具集 Then 无任何自身操作能力', () => {
    const { target, foreground, controller } = createFixture()
    for (const candidate of [
      { ...origin, triggeredBy: 'automation' },
      { ...origin, triggeredBy: 'delegation' },
      { ...origin, triggeredBy: 'external' },
      { ...origin, hasAutomationContext: true },
      { ...origin, trustedMainFrame: false },
      { ...origin, sessionId: 'another-session' },
    ]) {
      expect(foreground.grant(target, candidate, () => true)).toBeUndefined()
    }
    expect(foreground.grant(target, origin, () => false)).toBeUndefined()
    expect(buildPiPromaSelfTools(undefined, controller)).toEqual([])
  })

  test('Given 切出再切回同一会话 When 旧 Pi 调用继续执行 Then 旧授权永久失效', async () => {
    const { target, foreground, access, controller } = createFixture()
    const observe = buildPiPromaSelfTools(access, controller)[0]!
    foreground.set(target, sessionId)
    expect(access.isCurrent()).toBe(true)
    foreground.set(target, 'another-session')
    foreground.set(target, sessionId)
    expect(access.signal.aborted).toBe(true)
    await expect(observe.execute('call', {}, undefined, undefined, unusedContext)).rejects.toHaveProperty('name', 'AbortError')
    expect(foreground.grant(target, origin, () => true)?.isCurrent()).toBe(true)
  })

  test('Given Pi 工具正在等待 When 停止工具调用或撤销前台权限 Then 等待立即结束且无迟到结果', async () => {
    for (const source of ['pi', 'foreground']) {
      const { target, foreground, access, controller } = createFixture()
      let started = false
      const tools = buildPiPromaSelfTools(access, {
        ...controller,
        async waitFor(execution: PromaSelfExecution) {
          started = true
          await delay(10_000, undefined, { signal: execution.signal })
          return observation
        },
      })
      const abort = new AbortController()
      const wait = tools.find(tool => tool.name === 'PromaSelfWaitFor')!
      const result = wait.execute('call', { query: 'file-search' }, abort.signal, undefined, unusedContext)
      expect(started).toBe(true)
      if (source === 'pi') abort.abort()
      else foreground.set(target, null)
      await expect(result).rejects.toHaveProperty('name', 'AbortError')
    }
  })
})
