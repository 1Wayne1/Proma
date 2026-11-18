import { describe, expect, test } from 'bun:test'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { DriverConnection } from '../computer-use/transport'
import type { WindowConsent } from '../computer-use/window-session'
import { buildPiDesktopWindowTools } from './pi-desktop-window-tools'

const context = {} as Parameters<ToolDefinition['execute']>[4]
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRfcAAAAASUVORK5CYII='
function fixture() {
  const lifetime = new AbortController()
  const calls: string[] = []
  const connection: DriverConnection = {
    close() { calls.push('close') },
    async call(name) {
      calls.push(name)
      const target = { pid: 3210, window_id: 65 }
      if (name === 'list_windows') return { structuredContent: { windows: [{ ...target, app_name: '测试应用', title: '测试窗口' }] } }
      if (name === 'get_window_state') return { content: [{ type: 'image', mimeType: 'image/png', data: png }], structuredContent: {
        ...target, snapshot_id: 's0000000a', elements: [{ name: '保存', role: 'button', element_token: 's0000000a:1' }],
      } }
      return {}
    },
  }
  const consent: WindowConsent = {
    async choose(windows) { calls.push('choose'); return windows[0] },
    async confirm() { calls.push('confirm'); return true },
  }
  const tools = buildPiDesktopWindowTools({ signal: lifetime.signal, isCurrent: () => !lifetime.signal.aborted }, {
    async connect() { calls.push('connect'); return connection }, consent,
  })
  function invoke(name: string, args: Record<string, unknown>, signal?: AbortSignal) {
    return tools.find(tool => tool.name === name)!.execute('call', args, signal, undefined, context)
  }
  async function observe() {
    const result = await invoke('DesktopWindowObserve', { app: '测试', screenshot: true })
    const text = result.content[0]
    if (text?.type !== 'text') throw new Error('缺少窗口观察结果')
    const observation = JSON.parse(text.text) as { elements: { reference: string }[] }
    return { result, reference: observation.elements[0]!.reference }
  }
  return { lifetime, calls, consent, invoke, observe }
}

describe('Pi 桌面工具入口', () => {
  test('窗口选择、观察、动作确认和执行使用同一连接，并返回图片结果', async () => {
    const f = fixture()
    try {
      const { result, reference } = await f.observe()
      expect(result.content[1]).toEqual({ type: 'image', mimeType: 'image/png', data: png })
      await f.invoke('DesktopWindowAct', { reference })
      expect(f.calls).toEqual(['connect', 'list_windows', 'choose', 'list_windows', 'get_window_state', 'confirm', 'list_windows', 'click', 'close'])
      await expect(f.invoke('DesktopWindowAct', { reference })).rejects.toThrow('请先观察')
    } finally { f.lifetime.abort() }
  })

  for (const source of ['工具调用', '前台会话']) {
    test(`等待窗口确认时取消${source}，不再点击或重复申请授权`, async () => {
      const f = fixture(), toolCall = new AbortController()
      const entered = Promise.withResolvers<void>(), respond = Promise.withResolvers<boolean>()
      f.consent.confirm = async () => { entered.resolve(); return respond.promise }
      try {
        const { reference } = await f.observe()
        const running = f.invoke('DesktopWindowAct', { reference }, toolCall.signal)
        await entered.promise
        await expect(f.invoke('DesktopWindowAct', { reference })).rejects.toThrow('等待当前')
        if (source === '工具调用') toolCall.abort()
        else f.lifetime.abort()
        respond.resolve(true)
        await expect(running).rejects.toThrow()
        expect(f.calls.at(-1)).toBe('close')
        expect(f.calls).not.toContain('click')
      } finally { respond.resolve(false); f.lifetime.abort() }
    })
  }
})
