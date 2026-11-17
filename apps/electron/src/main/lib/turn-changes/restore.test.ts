import { afterEach, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { TurnChangeRecorder } from './recorder'
import { TurnRestoreService } from './restore'
import { writeTextFileAtomic } from '../safe-file'
import { commitRestoreFile, inspectRestoreFile } from './restore-files'
import { assertNoProjectMutation, withProjectMutation } from '../project-mutation-guard'

const roots: string[] = []
const owner = { sessionId: 'session', workspaceId: 'workspace', turnId: 'turn' }
async function fixture(before: string | Buffer | null = 'before', after: string | Buffer | null = 'after', path = '文件 空格.txt') {
  const root = await mkdtemp(join(tmpdir(), 'proma-restore-'))
  roots.push(root)
  const project = join(root, 'project')
  await mkdir(join(project, dirname(path)), { recursive: true })
  if (before !== null) await writeFile(join(project, path), before)
  const recorder = new TurnChangeRecorder(join(root, 'private'))
  const start = await recorder.begin({ ...owner, cwd: project, controlledPaths: [path] })
  if (after === null) await unlink(join(project, path))
  else await writeFile(join(project, path), after)
  const record = await recorder.finish(owner, start.recordId)
  const state = { available: true, busy: false, identity: 'identity', workspaceId: owner.workspaceId, now: Date.now(), notices: 0, authorize: async (): Promise<boolean> => true }
  const service = new TurnRestoreService(recorder.store, {
    resolveSession: id => state.available && id === owner.sessionId ? { workspaceId: state.workspaceId, roots: [project], identity: state.identity } : undefined,
    authorizeRoot: () => state.authorize(), isBusy: () => state.busy, now: () => state.now, onRestored: () => { state.notices++ },
  })
  const query = { ...owner, recordId: record.recordId, path }
  return { root, project, path, recorder, record, query, state, service }
}
afterEach(async () => {
  for (const root of roots.splice(0)) {
    if (dirname(resolve(root)) !== resolve(tmpdir())) throw new Error('临时根越界')
    await rm(root, { recursive: true, force: true })
  }
})
async function apply(f: Awaited<ReturnType<typeof fixture>>) {
  const preview = await f.service.preview(f.query)
  expect(preview.status).toBe('ready')
  return f.service.apply({ ...owner, previewId: preview.previewId! })
}

test('Given 中文路径与 BOM/CRLF 原始字节 When 预览后确认恢复 Then 字节精确恢复且快照保持不可变', async () => {
  const before = Buffer.from('\ufeff第一行\r\n第二行\r\n')
  const f = await fixture(before, 'after')
  const preview = await f.service.preview(f.query)
  expect(preview.diff?.before.content).toBe('after')
  expect(preview.diff?.after.content).toBe(before.toString('utf8'))
  expect((await f.service.apply({ ...owner, previewId: preview.previewId! })).status).toBe('restored')
  expect(await readFile(join(f.project, f.path))).toEqual(before)
  expect(await f.recorder.store.readText(owner, f.record.recordId, f.path, 'after')).toBe('after')
  expect(f.state.notices).toBe(1)
})
test('Given 本轮新增文件 When 恢复 Then 明确预览删除并仅删除指定文件', async () => {
  const f = await fixture(null, 'new')
  await writeFile(join(f.project, 'keep.txt'), 'keep')
  const preview = await f.service.preview(f.query)
  expect(preview.action).toBe('delete')
  expect((await f.service.apply({ ...owner, previewId: preview.previewId! })).status).toBe('restored')
  expect(await readdir(f.project)).not.toContain(f.path)
  expect(await readFile(join(f.project, 'keep.txt'), 'utf8')).toBe('keep')
})
test('Given 已删除的嵌套文件 When 恢复 Then 安全重建缺失父目录和文件', async () => {
  const f = await fixture('original', null, 'folder/child.txt')
  await rm(join(f.project, 'folder'), { recursive: true })
  const preview = await f.service.preview(f.query)
  expect((await f.service.apply({ ...owner, previewId: preview.previewId! })).status).toBe('restored')
  expect(await readFile(join(f.project, f.path), 'utf8')).toBe('original')
})
test('Given 二进制快照 When 恢复 Then 不借用文本编码并保留全部字节', async () => {
  const before = Buffer.from([0, 255, 1, 128])
  const f = await fixture(before, Buffer.from([0, 2]))
  const preview = await f.service.preview(f.query)
  expect(preview.diff?.after.content).toBeUndefined()
  expect((await f.service.apply({ ...owner, previewId: preview.previewId! })).status).toBe('restored')
  expect(await readFile(join(f.project, f.path))).toEqual(before)
})
test('Given 记录结束后用户编辑 When 预览 Then 返回冲突并保留用户内容', async () => {
  const f = await fixture()
  await writeFile(join(f.project, f.path), 'user edit')
  expect((await f.service.preview(f.query)).status).toBe('conflict')
  expect(await readFile(join(f.project, f.path), 'utf8')).toBe('user edit')
})
test('Given 预览后内容或文件身份变化 When 应用 Then 不覆盖新文件', async () => {
  for (const replacement of ['later edit', 'after']) {
    const f = await fixture()
    const preview = await f.service.preview(f.query)
    await rename(join(f.project, f.path), join(f.project, 'saved.txt'))
    await writeFile(join(f.project, f.path), replacement)
    expect((await f.service.apply({ ...owner, previewId: preview.previewId! })).status).toBe('conflict')
    expect(await readFile(join(f.project, f.path), 'utf8')).toBe(replacement)
  }
})
test('Given 异步授权期间后续编辑 When 应用 Then 最后的内容检查仍阻止写入', async () => {
  const f = await fixture()
  const preview = await f.service.preview(f.query)
  f.state.authorize = async () => { await writeFile(join(f.project, f.path), 'changed during authorization'); return true }
  expect((await f.service.apply({ ...owner, previewId: preview.previewId! })).status).toBe('conflict')
  expect(await readFile(join(f.project, f.path), 'utf8')).toBe('changed during authorization')
})
test('Given 短期预览、错误归属和重复应用 When 确认 Then 凭据只能由正确轮次使用一次', async () => {
  const f = await fixture()
  const preview = await f.service.preview(f.query)
  expect((await f.service.apply({ ...owner, sessionId: 'other', previewId: preview.previewId! })).status).toBe('expired')
  expect((await f.service.apply({ ...owner, previewId: preview.previewId! })).status).toBe('restored')
  expect((await f.service.apply({ ...owner, previewId: preview.previewId! })).status).toBe('expired')
  const expired = await fixture()
  const old = await expired.service.preview(expired.query)
  expired.state.now += 60_001
  expect((await expired.service.apply({ ...owner, previewId: old.previewId! })).status).toBe('expired')
  expect(await readFile(join(expired.project, expired.path), 'utf8')).toBe('after')
})
test('Given 会话删除、迁移或项目身份改变 When 应用 Then 预览失效且文件不变', async () => {
  for (const change of ['deleted', 'moved', 'identity'] as const) {
    const f = await fixture()
    const preview = await f.service.preview(f.query)
    if (change === 'deleted') f.state.available = false
    if (change === 'moved') f.state.workspaceId = 'other-workspace'
    if (change === 'identity') f.state.identity = 'changed'
    expect((await f.service.apply({ ...owner, previewId: preview.previewId! })).status).not.toBe('restored')
    expect(await readFile(join(f.project, f.path), 'utf8')).toBe('after')
  }
})
test('Given 项目根被同路径新目录替换 When 应用 Then 身份校验拒绝写入替换目录', async () => {
  const f = await fixture()
  const preview = await f.service.preview(f.query)
  await rename(f.project, join(f.root, 'original-root'))
  await mkdir(f.project)
  await writeFile(join(f.project, f.path), 'after')
  expect((await f.service.apply({ ...owner, previewId: preview.previewId! })).status).toBe('failed')
  expect(await readFile(join(f.project, f.path), 'utf8')).toBe('after')
})
test('Given 祖先目录变为链接 When 预览或应用 Then 不写链接目标', async () => {
  const f = await fixture('before', 'after', 'folder/x.txt')
  const preview = await f.service.preview(f.query)
  const outside = join(f.root, 'outside')
  await mkdir(outside)
  await writeFile(join(outside, 'x.txt'), 'outside')
  await rm(join(f.project, 'folder'), { recursive: true })
  await symlink(outside, join(f.project, 'folder'), process.platform === 'win32' ? 'junction' : 'dir')
  expect((await f.service.apply({ ...owner, previewId: preview.previewId! })).status).toBe('failed')
  await expect(f.service.preview(f.query)).rejects.toBeDefined()
  expect(await readFile(join(outside, 'x.txt'), 'utf8')).toBe('outside')
})
test('Given 活动任务或正在进行的根操作 When 恢复 Then 拒绝并保留文件', async () => {
  const f = await fixture()
  f.state.busy = true
  expect((await f.service.preview(f.query)).status).toBe('busy')
  f.state.busy = false
  const preview = await f.service.preview(f.query)
  f.state.busy = true
  expect((await f.service.apply({ ...owner, previewId: preview.previewId! })).status).toBe('busy')
  f.state.busy = false
  const next = await f.service.preview(f.query)
  await withProjectMutation(f.project, async () => {
    expect(() => assertNoProjectMutation([join(f.project, 'nested')])).toThrow('正在')
    expect((await f.service.apply({ ...owner, previewId: next.previewId! })).status).toBe('failed')
  })
  assertNoProjectMutation([f.project])
  expect(await readFile(join(f.project, f.path), 'utf8')).toBe('after')
})
test('Given 损坏快照与任意路径请求 When 预览 Then 不从当前磁盘伪造恢复正文', async () => {
  const f = await fixture()
  await expect(f.service.preview({ ...f.query, path: '../outside.txt' })).rejects.toBeDefined()
  await expect(f.service.preview({ ...f.query, sessionId: 'other' })).rejects.toBeDefined()
  await writeFile(join(f.root, 'private', f.record.recordId, 'snapshots', f.record.files[0]!.before.hash!), 'corrupt')
  await expect(f.service.preview(f.query)).rejects.toThrow('完整性')
  expect(await readFile(join(f.project, f.path), 'utf8')).toBe('after')
})
test('Given 已被清理的快照记录 When 应用旧预览 Then 不写入缓存中的恢复正文', async () => {
  const f = await fixture()
  const preview = await f.service.preview(f.query)
  await f.recorder.store.cleanup({ sessionId: owner.sessionId })
  expect((await f.service.apply({ ...owner, previewId: preview.previewId! })).status).toBe('failed')
  expect(await readFile(join(f.project, f.path), 'utf8')).toBe('after')
})
test('Given 恢复重建父目录后最终校验失败 When 回滚临时操作 Then 不留下空目录或改动目标', async () => {
  const f = await fixture()
  const current = inspectRestoreFile(f.project, 'new/child.txt', 1024)
  let checks = 0
  expect(() => commitRestoreFile(f.project, 'new/child.txt', current, Buffer.from('restore'), 1024, () => { if (++checks === 2) throw new Error('模拟身份改变') })).toThrow()
  expect(await readdir(f.project)).not.toContain('new')
})
test('Given Git 暂存区和无关脏文件 When 逐轮恢复 Then 只改选中文件并保留 index 字节', async () => {
  const f = await fixture()
  const git = (...args: string[]) => execFileSync('git', args, { cwd: f.project, encoding: 'utf8', windowsHide: true })
  git('init'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@proma.local')
  await writeFile(join(f.project, 'staged.txt'), 'staged')
  git('add', '.')
  const index = await readFile(join(f.project, '.git/index'))
  await writeFile(join(f.project, 'unrelated.txt'), 'keep me')
  expect((await apply(f)).status).toBe('restored')
  expect(await readFile(join(f.project, '.git/index'))).toEqual(index)
  expect(await readFile(join(f.project, 'unrelated.txt'), 'utf8')).toBe('keep me')
})
test('Given 同一输入超过十次执行 When 保存索引 Then 淘汰旧私有快照且不影响其他轮次', async () => {
  const f = await fixture()
  for (let i = 0; i < 11; i++) {
    const start = await f.recorder.begin({ ...owner, cwd: f.project, controlledPaths: [f.path] })
    await f.recorder.finish(owner, start.recordId)
  }
  expect((await f.recorder.store.list(owner)).length).toBe(10)
  expect((await readdir(join(f.root, 'private'))).filter(name => /^[a-f0-9-]{36}$/.test(name)).length).toBe(10)
})
test('Given 过期记录、其它会话和损坏私有目录 When 清理 Then 只删除可验证目标并报告保留项', async () => {
  const f = await fixture()
  const recordPath = join(f.root, 'private', f.record.recordId, 'record.json')
  const now = Date.now()
  writeTextFileAtomic(recordPath, JSON.stringify({ ...f.record, startedAt: now - 32 * 86400000, endedAt: now - 31 * 86400000 }))
  const corrupt = join(f.root, 'private', randomUUID())
  await mkdir(corrupt)
  await writeFile(join(corrupt, 'record.json'), 'broken')
  const result = await f.recorder.store.cleanup({ isSessionLive: () => true, now })
  expect(result.removed).toBe(1)
  expect(result.skipped).toBe(1)
  expect(await readdir(join(f.root, 'private'))).toContain(corrupt.split(/[\\/]/).pop()!)
  expect(await readFile(join(f.project, f.path), 'utf8')).toBe('after')
})

test('Given 未完成、超限或被取消的快照 When 预览恢复 Then 明确不可用且不写文件', async () => {
  const f = await fixture()
  const recorder = new TurnChangeRecorder(join(f.root, 'limited'), { maxFileBytes: 2 })
  const start = await recorder.begin({ ...owner, cwd: f.project, controlledPaths: [f.path] })
  const service = new TurnRestoreService(recorder.store, { resolveSession: () => ({ workspaceId: owner.workspaceId, roots: [f.project], identity: 'test' }), authorizeRoot: async () => true, isBusy: () => false })
  const query = { ...owner, recordId: start.recordId, path: f.path }
  expect((await service.preview(query)).status).toBe('unavailable')
  await recorder.finish(owner, start.recordId, 'cancelled')
  expect((await service.preview(query)).status).toBe('unavailable')
  expect(await readFile(join(f.project, f.path), 'utf8')).toBe('after')
})
test('Given 崩溃遗留和仍然活动的未完成记录 When 日常清理 Then 只清理超过一天且已不活动的记录', async () => {
  const f = await fixture()
  const start = await f.recorder.begin({ ...owner, turnId: 'unfinished', cwd: f.project })
  const path = join(f.root, 'private', start.recordId, 'record.json')
  writeTextFileAtomic(path, JSON.stringify({ ...start, startedAt: Date.now() - 25 * 60 * 60 * 1000 }))
  const active = await f.recorder.store.cleanup({ isSessionLive: () => true, isRecordActive: () => true })
  expect(active.removed).toBe(0)
  await f.recorder.finish(start, start.recordId, 'cancelled')
  writeTextFileAtomic(path, JSON.stringify({ ...start, startedAt: Date.now() - 25 * 60 * 60 * 1000 }))
  const stale = await f.recorder.store.cleanup({ isSessionLive: () => true, isRecordActive: id => f.recorder.isRecordActive(id) })
  expect(stale.removed).toBe(1)
})
