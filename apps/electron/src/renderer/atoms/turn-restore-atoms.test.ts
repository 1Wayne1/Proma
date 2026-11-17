import { expect, test } from 'bun:test'
import { createTurnRestoreController } from './turn-restore-atoms'
import type { TurnRestorePreview, TurnRestoreResult } from '@proma/shared'

const file = { sessionId: 'session', turnId: 'turn', recordId: 'record', path: 'file.txt' }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
test('Given 确认前未预览或连续点击 When 应用恢复 Then 只发送一次当前 token', async () => {
  const writes: unknown[] = []
  const wait = deferred<TurnRestoreResult>()
  const controller = createTurnRestoreController({ previewTurnRestore: async () => ({ status: 'ready', path: file.path, previewId: 'token' }), applyTurnRestore: async input => { writes.push(input); return wait.promise } }, file, () => {})
  await controller.apply()
  expect(writes).toEqual([])
  await controller.preview()
  const first = controller.apply(); await controller.apply()
  expect(writes).toEqual([{ sessionId: 'session', turnId: 'turn', previewId: 'token' }])
  wait.resolve({ status: 'restored', path: file.path }); await first
  await controller.apply()
  expect(writes.length).toBe(1)
})
test('Given 预览取消或组件卸载 When 旧响应到达 Then 不重新激活恢复确认', async () => {
  for (const dispose of [false, true]) {
    const wait = deferred<TurnRestorePreview>(); const updates: unknown[] = []
    const controller = createTurnRestoreController({ previewTurnRestore: () => wait.promise, applyTurnRestore: async () => { throw new Error('不应调用') } }, file, patch => updates.push(patch))
    const pending = controller.preview()
    if (dispose) controller.dispose(); else controller.cancel()
    const count = updates.length
    wait.resolve({ status: 'ready', path: file.path, previewId: 'late' }); await pending
    expect(updates.length).toBe(count)
    await controller.apply()
  }
})
test('Given 后端报告冲突或写入响应丢失 When 处理结果 Then 不重放写入且必须重新预览', async () => {
  let calls = 0
  const updates: Array<{ error?: string | null; result?: TurnRestoreResult | null }> = []
  const controller = createTurnRestoreController({ previewTurnRestore: async () => ({ status: 'ready', path: file.path, previewId: 'token' }), applyTurnRestore: async () => { calls++; throw new Error('transport failure') } }, file, patch => updates.push(patch))
  await controller.preview(); await controller.apply(); await controller.apply()
  expect(calls).toBe(1)
  expect(updates.some(patch => patch.error?.includes('不会自动重放'))).toBe(true)
})
