import { describe, expect, test } from 'bun:test'
import { NetworkDiagnosticPreviews } from './network-diagnostics'
import { NetworkMonitor } from './network-monitor'

describe('诊断预览与导出绑定', () => {
  test('Given 已预览快照 When 连接状态变化或调用方修改副本 Then 导出仍是原预览', () => {
    const monitor = new NetworkMonitor()
    const previews = new NetworkDiagnosticPreviews(() => 100)
    const preview = previews.create(1, monitor.snapshot())
    preview.report.snapshot.onlineHint = true
    monitor.notifyOnline(false)
    expect(previews.read(1, preview.previewId).report.snapshot).toMatchObject({ revision: 0, onlineHint: null })
  })
  test('Given 其他窗口或任意 ID When 导出 Then 拒绝访问', () => {
    const previews = new NetworkDiagnosticPreviews()
    const preview = previews.create(1, new NetworkMonitor().snapshot())
    expect(() => previews.read(2, preview.previewId)).toThrow('失效')
    expect(() => previews.read(1, { injected: true })).toThrow('失效')
  })
  test('Given 预览过期或被替代 When 导出 Then 要求重新预览', () => {
    let now = 0
    const previews = new NetworkDiagnosticPreviews(() => now)
    const first = previews.create(1, new NetworkMonitor().snapshot())
    const current = previews.create(1, new NetworkMonitor().snapshot())
    expect(() => previews.read(1, first.previewId)).toThrow()
    now = 600_001
    expect(() => previews.read(1, current.previewId)).toThrow()
    previews.clear()
    expect(() => previews.read(1, current.previewId)).toThrow()
  })
})
