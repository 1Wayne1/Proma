import { expect, test } from 'bun:test'
import { createStore } from 'jotai'
import type { TurnChangeRecord, TurnFileDiff } from '@proma/shared'
import { createTurnChangesController, createTurnChangesViewAtom } from './turn-changes-atoms'
import type { TurnChangesViewState } from './turn-changes-atoms'

function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
function view() { const store = createStore(); const atom = createTurnChangesViewAtom(); return { read: () => store.get(atom), update: (patch: Partial<TurnChangesViewState>) => store.set(atom, previous => ({ ...previous, ...patch })) } }
const diff: TurnFileDiff = { path: 'new.txt', before: { snapshot: { availability: 'missing' }, content: '' }, after: { snapshot: { availability: 'missing' }, content: '' } }

test('Given 刷新列表期间仍有旧文件请求 When 新列表返回 Then 清除旧选择并拒绝迟到文件', async () => {
  const records = deferred<TurnChangeRecord[]>()
  const file = deferred<TurnFileDiff>()
  const state = view()
  const controller = createTurnChangesController({ getTurnChanges: () => records.promise, getTurnFileDiff: () => file.promise }, { sessionId: 's', turnId: 't' }, state.update)
  const loading = controller.load()
  const oldFile = controller.loadDiff('old-record', 'new.txt')
  records.resolve([])
  await loading
  file.resolve(diff)
  await oldFile
  expect(state.read().selectedRecordId).toBeNull()
  expect(state.read().selectedPath).toBeNull()
  expect(state.read().diff).toBeNull()
})

test('Given 两个文件请求乱序返回 When 后一个文件已选择 Then 不被旧响应覆盖', async () => {
  const first = deferred<TurnFileDiff>()
  const second = deferred<TurnFileDiff>()
  const state = view()
  const controller = createTurnChangesController({ getTurnChanges: async () => [], getTurnFileDiff: input => input.path === 'old.txt' ? first.promise : second.promise }, { sessionId: 's', turnId: 't' }, state.update)
  const old = controller.loadDiff('r', 'old.txt')
  const current = controller.loadDiff('r', 'new.txt')
  second.resolve(diff)
  await current
  first.resolve({ ...diff, path: 'old.txt' })
  await old
  expect(state.read().diff?.path).toBe('new.txt')
  expect(state.read().selectedPath).toBe('new.txt')
  controller.dispose()
})

test('Given 记录刷新或切换执行记录 When 旧文件迟到 Then 不写入新选择', async () => {
  const pending = deferred<TurnFileDiff>()
  const state = view()
  const controller = createTurnChangesController({ getTurnChanges: async () => [], getTurnFileDiff: () => pending.promise }, { sessionId: 's', turnId: 't' }, state.update)
  const request = controller.loadDiff('old-record', 'old.txt')
  controller.selectRecord('new-record')
  pending.resolve(diff)
  await request
  expect(state.read().selectedRecordId).toBe('new-record')
  expect(state.read().diff).toBeNull()
  await controller.load()
  expect(state.read().records).toEqual([])
  expect(state.read().selectedRecordId).toBeNull()
})

test('Given 面板已卸载 When 列表或错误迟到 Then 不再更新 Jotai 状态', async () => {
  const pending = deferred<TurnChangeRecord[]>()
  const state = view()
  const controller = createTurnChangesController({ getTurnChanges: () => pending.promise, getTurnFileDiff: async () => diff }, { sessionId: 's', turnId: 't' }, state.update)
  const request = controller.load()
  const before = state.read()
  controller.dispose()
  pending.reject(new Error('late secret error'))
  await request
  expect(state.read()).toBe(before)
})

test('Given 快照请求失败 When 再次读取 Then 显示失败并能恢复而不回退到磁盘', async () => {
  const state = view()
  let attempts = 0
  const controller = createTurnChangesController({ getTurnChanges: async () => [], getTurnFileDiff: async () => { if (++attempts === 1) throw new Error('private-path'); return diff } }, { sessionId: 's', turnId: 't' }, state.update)
  await controller.loadDiff('r', 'new.txt')
  expect(state.read().diffError).toContain('不会改为读取当前磁盘')
  expect(state.read().diffError).not.toContain('private-path')
  await controller.loadDiff('r', 'new.txt')
  expect(state.read().diffError).toBeNull()
  expect(state.read().diff?.path).toBe('new.txt')
})
