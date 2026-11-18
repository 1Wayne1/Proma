import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { driverLocation, verifyDriver } from './driver'
import { DesktopWindowSession } from './window-session'
import type { WindowConsent } from './window-session'
import type { DriverConnection } from './transport'
import { buildPiDesktopWindowTools } from '../adapters/pi-desktop-window-tools'

const signal = new AbortController().signal
function fixture(platform: NodeJS.Platform = 'win32') {
  const calls: { name: string; args: Record<string, unknown> }[] = []
  const window = { pid: 430, window_id: 80, title: '测试', app_name: '测试应用' }
  let allowed = true
  const consent: WindowConsent = { choose: async rows => rows[0], confirm: async () => allowed }
  const conn: DriverConnection = {
    close() {},
    async call(name, args) {
      calls.push({ name, args })
      if (name === 'list_windows') return { structuredContent: { windows: [window] } }
      return { structuredContent: { pid: window.pid, window_id: window.window_id, window_title: window.title, snapshot_id: 's00000001',
        elements: [{ element_token: 's00000001:1', role: platform === 'darwin' ? 'AXTextField' : 'Edit', name: '名称', value: '不要返回该内容' }] } }
    },
  }
  const session = new DesktopWindowSession(conn, consent, () => signal.throwIfAborted(), platform)
  const observe = async () => (await session.observe('测试应用', false, signal)).elements[0]!.reference
  return { session, calls, window, observe, consent, deny: () => { allowed = false } }
}

describe('S6-01 桌面驱动', () => {
  test('仅在 Windows x64 和 Apple Silicon 提供官方固定位置', () => {
    expect(driverLocation('win32', 'x64', 'D:\\Local')?.file).toBe('D:\\Local\\Programs\\Cua\\cua-driver\\bin\\cua-driver.exe')
    expect(driverLocation('darwin', 'arm64')?.file).toBe('/Applications/CuaDriver.app/Contents/MacOS/cua-driver')
    expect(driverLocation('darwin', 'x64')).toBeUndefined()
    expect(driverLocation('win32', 'arm64')).toBeUndefined()
    expect(driverLocation('linux', 'x64')).toBeUndefined()
  })
  test('主程序或辅助程序摘要不符时拒绝启动', async () => {
    const file = import.meta.path
    const correct = createHash('sha256').update(await Bun.file(file).bytes()).digest('hex')
    expect(await verifyDriver({ file, sha256: correct }, signal)).toBe(file)
    await expect(verifyDriver({ file, sha256: 'bad' }, signal)).rejects.toThrow('校验')
    await expect(verifyDriver({ file, sha256: correct, helper: { file, sha256: 'bad' } }, signal)).rejects.toThrow('校验')
  })
  test('后台、切走或已停止的运行不会注册桌面工具', () => {
    expect(buildPiDesktopWindowTools(undefined)).toEqual([])
    expect(buildPiDesktopWindowTools({ isCurrent: () => false, signal })).toEqual([])
    expect(buildPiDesktopWindowTools({ isCurrent: () => true, signal: AbortSignal.abort() })).toEqual([])
  })
  for (const platform of ['win32', 'darwin'] as const) {
    test(`${platform}：选择目标后只可对当次引用操作一次`, async () => {
      const f = fixture(platform)
      const ref = await f.observe()
      await f.session.act(ref, '填入', signal)
      expect(f.calls.at(-1)).toEqual({ name: 'set_value', args: { session: expect.any(String), pid: 430, window_id: 80, element_token: 's00000001:1', value: '填入', ...(platform === 'win32' ? { delivery_mode: 'background' } : {}) } })
      await expect(f.session.act(ref, undefined, signal)).rejects.toThrow('失效')
    })
  }
  test('用户拒绝后无写入，重新选择后可点击', async () => {
    const f = fixture(), ref = await f.observe()
    f.deny()
    await expect(f.session.act(ref, '填入', signal)).rejects.toThrow('取消')
    expect(f.calls.some(call => call.name === 'set_value')).toBe(false)
    const next = fixture()
    await next.session.act(await next.observe(), undefined, signal)
    expect(next.calls.at(-1)?.name).toBe('click')
  })
  test('目标 PID、更换的窗口标题和跨运行引用均无法沿用授权', async () => {
    for (const change of ['pid', 'title']) {
      const f = fixture(), ref = await f.observe()
      if (change === 'pid') f.window.pid++
      else f.window.title = '另一窗口'
      await expect(f.session.act(ref, '填入', signal)).rejects.toThrow('身份')
    }
    const f = fixture(), other = fixture(), ref = await f.observe()
    await other.observe()
    await expect(other.session.act(ref, undefined, signal)).rejects.toThrow('失效')
  })
  test('取消选择或截图不可用时不留下操作引用', async () => {
    const f = fixture()
    await expect(f.session.observe('测试', true, signal)).rejects.toThrow('截图')
    f.consent.choose = async () => undefined
    await expect(f.observe()).rejects.toThrow('取消')
  })
  test('预览独立取帧保留操作引用，窗口身份改变后拒绝取帧及激活', async () => {
    const f = fixture()
    const ref = await f.observe()
    let captures = 0, activations = 0
    const preview = f.session.previewSource(async () => ({
      close() {},
      async call(tool, args) {
        if (tool === 'list_windows') return { structuredContent: { windows: [f.window] } }
        if (tool === 'bring_to_front') { activations++; return { structuredContent: { activated: true } } }
        expect(args.display_only).toBe(true)
        expect(args.include_accessibility_tree).toBe(false)
        captures++
        return { structuredContent: f.window, content: [{ type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgo=' }] }
      },
    }))
    try {
      await preview.capture(signal, false)
      await preview.activate(signal)
      await f.session.act(ref, '写入', signal)
      f.window.title = '另一个窗口'
      await expect(preview.capture(signal, false)).rejects.toThrow('目标窗口')
      await expect(preview.activate(signal)).rejects.toThrow('目标窗口')
      expect(captures).toBe(1)
      expect(activations).toBe(1)
    } finally { preview.close() }
  })
})
