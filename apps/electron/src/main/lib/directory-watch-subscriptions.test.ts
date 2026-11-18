import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, mkdir, realpath, rm, symlink } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { DirectoryWatchSubscriptions } from './directory-watch-subscriptions'
import { assertNoProjectMutation, canonicalProjectPath, hasProjectActivity, registerProjectActivity, withProjectMutation } from './project-mutation-guard'

const roots: string[] = []
async function fixture() { const root = await mkdtemp(join(tmpdir(), 'proma-watch-refs-')); roots.push(root); return root }
afterEach(async () => { for (const root of roots.splice(0)) { if (dirname(resolve(root)) !== resolve(tmpdir())) throw new Error('临时根越界'); await rm(root, { recursive: true, force: true }) } })
test('Given 两个会话共享目录 When 删除一个再删除最后一个 Then 底层 watcher 仅启动和关闭一次', async () => {
  const root = await fixture()
  const events: string[] = []
  const registry = new DirectoryWatchSubscriptions(path => events.push(`start:${path}`), path => events.push(`stop:${path}`))
  registry.sync(new Map([['session:a', [root, root]], ['session:b', [root]]]))
  registry.sync(new Map([['session:a', [root]], ['session:b', [root]]]))
  expect(registry.refCount(root)).toBe(2)
  registry.sync(new Map([['session:b', [root]]]))
  expect(events.length).toBe(1)
  expect(registry.refCount(root)).toBe(1)
  registry.sync(new Map())
  expect(events.length).toBe(2)
  expect(registry.has(root)).toBe(false)
})
test('Given 路径别名与会话/工作区共同引用 When 订阅 Then 按真实根共享并在切换后释放旧根', async () => {
  const root = await fixture()
  const actual = join(root, 'actual'); const alias = join(root, 'alias'); const next = join(root, 'next')
  await mkdir(actual); await mkdir(next)
  await symlink(actual, alias, process.platform === 'win32' ? 'junction' : 'dir')
  const events: string[] = []
  const registry = new DirectoryWatchSubscriptions(path => events.push(`start:${path}`), path => events.push(`stop:${path}`))
  registry.sync(new Map([['workspace:a', [actual]], ['session:b', [alias]]]))
  expect(registry.refCount(alias)).toBe(2)
  expect(events.length).toBe(1)
  registry.sync(new Map([['session:b', [next]]]))
  expect(events.length).toBe(3)
  registry.clear(); registry.clear()
  expect(events.length).toBe(4)
})
test('Given 根操作锁与目录别名 When Agent 或终端尝试进入 Then 子目录和祖先均受保护且失败后释放', async () => {
  const root = await fixture()
  const actual = join(root, 'actual'); const alias = join(root, 'alias')
  await mkdir(actual)
  await symlink(actual, alias, process.platform === 'win32' ? 'junction' : 'dir')
  await expect(withProjectMutation(actual, async () => {
    expect(() => assertNoProjectMutation([join(alias, 'missing')])).toThrow('正在')
    await expect(withProjectMutation(root, async () => {})).rejects.toThrow('正在')
    throw new Error('fixture failure')
  })).rejects.toThrow('fixture failure')
  assertNoProjectMutation([alias])
  expect(canonicalProjectPath(join(alias, 'missing'))).toBe(join(await realpath(actual), 'missing'))
})

test('Given 临时附加根及停止中的旧代次 When 查询和释放 Then 停止完成前仍保护目录且不释放新代次', async () => {
  const root = await fixture()
  const first = join(root, 'first'); const additional = join(root, 'additional')
  await mkdir(first); await mkdir(additional)
  const old = registerProjectActivity([first, additional])
  const stopBarrier = old.retain()
  old.release(); old.release()
  expect(hasProjectActivity(additional)).toBe(true)
  await expect(withProjectMutation(additional, async () => {})).rejects.toThrow('停止')
  const next = registerProjectActivity([additional])
  stopBarrier(); stopBarrier()
  expect(hasProjectActivity(additional)).toBe(true)
  next.release()
  expect(hasProjectActivity(additional)).toBe(false)
  await withProjectMutation(additional, async () => { expect(() => registerProjectActivity([additional])).toThrow('正在') })
})
