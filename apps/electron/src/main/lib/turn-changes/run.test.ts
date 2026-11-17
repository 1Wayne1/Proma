import { afterEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { TurnChangeRecorder } from './recorder'
import { TurnChangesRun, withTurnChangesPermission } from './run'
import type { PermissionResult } from '../agent-permission-service'
import { PendingPromptSkillActivationTracker } from '../adapters/pi-skill-activation-tracker'

const owner = { sessionId: 'session', workspaceId: 'workspace', turnId: 'u1' }
const roots: string[] = []
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'proma-turn-run-'))
  roots.push(root)
  const project = join(root, 'project')
  const workbench = join(root, 'workbench')
  await mkdir(project)
  await mkdir(workbench)
  const recorder = new TurnChangeRecorder(join(root, 'snapshots'))
  let current = true
  const run = new TurnChangesRun({ owner, root: project, toolCwd: workbench, recorder, isCurrent: () => current })
  return { root, project, workbench, recorder, run, invalidate: () => { current = false } }
}
afterEach(async () => {
  for (const root of roots.splice(0)) {
    if (dirname(resolve(root)) !== resolve(tmpdir())) throw new Error('临时根越界')
    await rm(root, { recursive: true, force: true })
  }
})

test('Given 权限允许并改写路径 When 工具真正执行 Then 先捕获最终路径且权限结果原样返回', async () => {
  const f = await fixture()
  const target = join(f.project, 'x.txt')
  await writeFile(target, 'before')
  await f.run.advance('u1')
  const permission: PermissionResult = { behavior: 'allow', updatedInput: { file_path: target } }
  const authorize = withTurnChangesPermission(async () => permission, () => f.run, () => true)
  expect(await authorize('Write', { file_path: 'wrong.txt' }, { signal: new AbortController().signal, toolUseID: 'tool' })).toBe(permission)
  await writeFile(target, 'after')
  await f.run.finish()
  const [record] = await f.recorder.store.list(owner)
  expect(record?.files.map(file => file.path)).toEqual(['x.txt'])
  expect(await f.recorder.store.readText(owner, record!.recordId, 'x.txt', 'before')).toBe('before')
  expect(await f.recorder.store.readText(owner, record!.recordId, 'x.txt', 'after')).toBe('after')
})

test('Given 权限拒绝 When 工具请求写入 Then 不执行采样也不改变授权结果', async () => {
  const f = await fixture()
  await f.run.advance('u1')
  const denied: PermissionResult = { behavior: 'deny', message: '用户拒绝' }
  const authorize = withTurnChangesPermission(async () => denied, () => f.run, () => true)
  expect(await authorize('Write', { file_path: join(f.project, 'x.txt') }, { signal: new AbortController().signal, toolUseID: 'tool' })).toBe(denied)
  await f.run.finish()
  expect((await f.recorder.store.list(owner))[0]?.files).toEqual([])
})

test('Given 无 Skill 的追加输入与相同文本 When Pi 接纳输入 Then 保留独立 UUID 并能撤销失败入队', () => {
  const tracker = new PendingPromptSkillActivationTracker()
  tracker.register('same', 'u1', [])
  const rejected = tracker.register('same', 'discarded', [])
  tracker.register('same', 'u2', [])
  tracker.discard(rejected)
  expect(tracker.consume('same')?.userMessageUuid).toBe('u1')
  expect(tracker.consume('same')?.userMessageUuid).toBe('u2')
  expect(tracker.consume('same')).toBeUndefined()
})

test('Given Pi 已接纳追加输入 When 下一次工具到达 Then 等待轮次切换且不把后续修改算入上一轮', async () => {
  const f = await fixture()
  const target = join(f.project, 'x.txt')
  await writeFile(target, 'a')
  await f.run.advance('u1')
  await f.run.before('Write', { file_path: target }, new AbortController().signal)
  await writeFile(target, 'b')
  void f.run.advance('u2')
  await f.run.before('Edit', { file_path: target }, new AbortController().signal)
  await writeFile(target, 'c')
  await f.run.advance('u1') // 迟到的旧输入回调不能切回去。
  await f.run.finish()
  const [first] = await f.recorder.store.list(owner)
  const [second] = await f.recorder.store.list({ ...owner, turnId: 'u2' })
  expect(await f.recorder.store.readText(owner, first!.recordId, 'x.txt', 'after')).toBe('b')
  expect(await f.recorder.store.readText({ ...owner, turnId: 'u2' }, second!.recordId, 'x.txt', 'before')).toBe('b')
  expect(await f.recorder.store.readText({ ...owner, turnId: 'u2' }, second!.recordId, 'x.txt', 'after')).toBe('c')
  expect(f.recorder.activeCount).toBe(0)
})

test('Given 停止或旧代次的迟到许可 When 权限等待结束 Then 不继续派发工具', async () => {
  const f = await fixture()
  await f.run.advance('u1')
  let release!: (permission: PermissionResult) => void
  const authorize = withTurnChangesPermission(() => new Promise(resolve => { release = resolve }), () => f.run, () => true)
  const pending = authorize('Write', { file_path: join(f.project, 'x.txt') }, { signal: new AbortController().signal, toolUseID: 'tool' })
  f.run.abort()
  release({ behavior: 'allow' })
  await expect(pending).rejects.toBeDefined()
  await f.run.finish()
  expect((await f.recorder.store.list(owner))[0]?.completion).toBe('cancelled')
  expect(f.recorder.activeCount).toBe(0)
  const stale = withTurnChangesPermission(async () => ({ behavior: 'allow' }), () => undefined, () => false)
  await expect(stale('Write', {}, { signal: new AbortController().signal, toolUseID: 'late' })).rejects.toBeDefined()
})

test('Given 已授权的附加目录写入 When 不属于采样根 Then 标注未覆盖而不读取该目录', async () => {
  const f = await fixture()
  await f.run.advance('u1')
  await f.run.before('Write', { file_path: join(f.workbench, 'outside.txt') }, new AbortController().signal)
  await f.run.finish()
  const [record] = await f.recorder.store.list(owner)
  expect(record?.limitations).toContain('additional-root-not-captured')
  expect(record?.files).toEqual([])
})

test('Given 任务报错但代次仍有效 When 收束 Then 保留已经写入文件的后快照', async () => {
  const f = await fixture()
  const target = join(f.project, 'x.txt')
  await writeFile(target, 'before')
  await f.run.advance('u1')
  await f.run.before('Write', { file_path: target }, new AbortController().signal)
  await writeFile(target, 'changed before failure')
  await f.run.finish('failed')
  const [record] = await f.recorder.store.list(owner)
  expect(record?.completion).toBe('failed')
  expect(await f.recorder.store.readText(owner, record!.recordId, 'x.txt', 'after')).toBe('changed before failure')
})

test('Given 开始采样期间停止 When begin 迟到 Then 不留下活跃捕获或后续轮次', async () => {
  const f = await fixture()
  void f.run.advance('u1')
  f.run.abort()
  f.invalidate()
  await f.run.finish('cancelled')
  await f.run.advance('u2')
  expect(f.recorder.activeCount).toBe(0)
  expect(await f.recorder.store.list({ ...owner, turnId: 'u2' })).toEqual([])
})
