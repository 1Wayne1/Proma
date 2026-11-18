import { describe, expect, test } from 'bun:test'
import { DesktopPreviewRegistry } from './preview'
import type { PreviewSource } from './preview'
import type { DesktopPreviewCommand } from '@proma/shared'

function fixture(source: Partial<PreviewSource> = {}) {
  const registry = new DesktopPreviewRegistry(() => {})
  const lifetime = new AbortController()
  const driver: PreviewSource = { capture: async () => 'png', activate: async () => {}, close() {}, ...source }
  const bind = () => registry.bind('session', '测试窗口', driver, lifetime.signal, () => !lifetime.signal.aborted)
  bind()
  const id = registry.state('session')!.id
  const send = (action: DesktopPreviewCommand['action']) => registry.command({ sessionId: 'session', id, action })
  return { registry, lifetime, bind, id, send }
}

describe('桌面预览生命周期', () => {
  test('取帧期间的并发请求被丢弃，停止后迟到的帧不会返回', async () => {
    const deferred = Promise.withResolvers<string>()
    let captures = 0
    const f = fixture({ capture() { captures++; return deferred.promise } })
    const first = f.send('frame')
    expect(await f.send('frame')).toBeNull()
    expect(captures).toBe(1)
    await f.send('stop')
    deferred.resolve('旧画面')
    expect(await first).toBeNull()
    expect(f.registry.state('session')).toBeNull()
  })

  test('更换目标后旧标识及跨会话请求均失效，撤权清空预览', async () => {
    const f = fixture()
    f.bind()
    expect(await f.send('frame')).toBeNull()
    expect(await f.send('stop')).toBeNull()
    const id = f.registry.state('session')!.id
    expect(await f.registry.command({ sessionId: '其他会话', id, action: 'activate' })).toBeNull()
    f.lifetime.abort()
    expect(f.registry.state('session')).toBeNull()
  })

  test('快照失败后可低频回退，失败可见，重试后恢复取帧并激活', async () => {
    let fail = true, activations = 0
    const f = fixture({ capture: async (_signal, low) => {
      if (fail) throw new Error('窗口不可用')
      return low ? '小图' : '原图'
    }, activate: async () => { activations++ } })
    try {
      await f.send('frame')
      expect(f.registry.state('session')?.mode).toBe('snapshot')
      await f.send('retry')
      await f.send('frame')
      expect(f.registry.state('session')?.error).toBe('窗口不可用')
      fail = false
      await f.send('retry')
      expect(await f.send('frame')).toEqual({ id: f.id, png: '小图', delayMs: 2000 })
      expect(await f.send('frame')).toBeNull()
      await f.send('activate')
      expect(activations).toBe(1)
    } finally { f.registry.closeAll() }
  })
})
