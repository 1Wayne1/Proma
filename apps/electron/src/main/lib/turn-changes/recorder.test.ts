import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, mkdir, readFile, readdir, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import type { TurnChangeOwner } from '@proma/shared'
import { TurnChangeRecorder } from './recorder'
import { TurnChangeStore } from './store'
import { writeTextFileAtomic } from '../safe-file'
import { normalizeTurnPath } from './paths'
import { validateTurnLimits } from './capture'

test('Given 活跃轮次达到上限 When 新轮次开始 Then 拒绝且已有记录仍可结束', async () => {
  const { project, storage } = await fixture()
  const recorder = new TurnChangeRecorder(storage)
  const starts = await Promise.all(Array.from({ length: 8 }, (_, i) => recorder.begin({ ...owner, turnId: `turn-${i}`, cwd: project })))
  await expect(recorder.begin({ ...owner, turnId: 'one-too-many', cwd: project })).rejects.toThrow('上限')
  await Promise.all(starts.map(start => recorder.finish(start, start.recordId, 'cancelled')))
  expect(recorder.activeCount).toBe(0)
})

test('Given 受控捕获持久化失败 When 恢复存储后重试 Then 不提交失败时的 before 或消耗其预算', async () => {
  const { project, storage, root } = await fixture()
  await writeFile(join(project, 'x.txt'), '1234')
  const recorder = new TurnChangeRecorder(storage, { maxSnapshotBytes: 8 })
  const start = await recorder.begin({ ...owner, cwd: project })
  const blobs = join(storage, start.recordId, 'snapshots')
  const moved = join(root, 'saved-snapshots')
  await rename(blobs, moved)
  await writeFile(blobs, 'obstruction')
  await expect(recorder.captureBefore(owner, start.recordId, 'x.txt')).rejects.toBeDefined()
  await unlink(blobs)
  await rename(moved, blobs)
  await writeFile(join(project, 'x.txt'), '5678')
  await recorder.captureBefore(owner, start.recordId, 'x.txt')
  await writeFile(join(project, 'x.txt'), 'abcd')
  const record = await recorder.finish(owner, start.recordId)
  expect(record.partial).toBe(false)
  expect(await recorder.store.readText(owner, record.recordId, 'x.txt', 'before')).toBe('5678')
})

test('Given Windows 大小写路径别名 When 工具重复捕获 Then 只记录同一个文件', async () => {
  if (process.platform !== 'win32') return
  const { project, storage } = await fixture()
  await writeFile(join(project, 'case.txt'), '1234')
  const recorder = new TurnChangeRecorder(storage, { maxSnapshotBytes: 8 })
  const start = await recorder.begin({ ...owner, cwd: project, controlledPaths: ['case.txt'] })
  await recorder.captureBefore(owner, start.recordId, 'CASE.TXT')
  await writeFile(join(project, 'case.txt'), '5678')
  const record = await recorder.finish(owner, start.recordId)
  expect(record.files.length).toBe(1)
  expect(record.partial).toBe(false)
  expect(await recorder.store.readText(owner, record.recordId, 'CASE.TXT', 'before')).toBe('1234')
})

test('Given 快照位置位于项目内 When 开始捕获 Then 拒绝自我递归捕获', async () => {
  const { project } = await fixture()
  const recorder = new TurnChangeRecorder(join(project, 'private-snapshots'))
  await expect(recorder.begin({ ...owner, cwd: project })).rejects.toThrow('项目之外')
  expect(recorder.activeCount).toBe(0)
})

test('Given 快照父目录指向项目 When 开始捕获 Then 拒绝且不创建存储目录', async () => {
  const { project, root } = await fixture()
  const alias = join(root, 'storage-alias')
  await symlink(project, alias, process.platform === 'win32' ? 'junction' : 'dir')
  const recorder = new TurnChangeRecorder(join(alias, 'private-snapshots'))
  await expect(recorder.begin({ ...owner, cwd: project })).rejects.toThrow('项目之外')
  expect(await readdir(project)).toEqual([])
})

test('Given Windows 数据流与设备路径 When 规范化 Then 不把它们当普通文件', () => {
  for (const path of ['file.txt:secret', 'CON', 'folder/NUL.txt', 'a.', 'folder/space ']) expect(() => normalizeTurnPath(path)).toThrow()
})

const roots: string[] = []
const owner: TurnChangeOwner = { sessionId: 'session-1', turnId: 'turn-1', workspaceId: 'workspace-1' }

async function fixture(): Promise<{ root: string; project: string; storage: string }> {
  const root = await mkdtemp(join(tmpdir(), 'proma-turn-changes-'))
  roots.push(root)
  const project = join(root, '项目 空格')
  await mkdir(project)
  return { root, project, storage: join(root, 'private-snapshots') }
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
}

async function repository(project: string): Promise<void> {
  git(project, 'init')
  git(project, 'config', 'user.name', 'Proma Fixture')
  git(project, 'config', 'user.email', 'fixture@proma.local')
  await writeFile(join(project, 'tracked.txt'), 'committed\n')
  await writeFile(join(project, 'deleted.txt'), 'delete me\n')
  git(project, 'add', '.')
  git(project, 'commit', '-m', 'fixture')
}

afterEach(async () => {
  for (const root of roots.splice(0)) {
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !root.includes('proma-turn-changes-')) throw new Error('拒绝清理测试临时根之外的路径')
    await rm(root, { recursive: true, force: true })
  }
})

describe('逐轮捕获、比较与私有存储', () => {
  test('Given 非 Git 项目与受控文件 When 一轮修改新增删除 Then 保留原始 CRLF、中文路径和归属', async () => {
    const { project, storage } = await fixture()
    await writeFile(join(project, '中文 空格.txt'), '\uFEFFbefore\r\n')
    await writeFile(join(project, 'delete.txt'), 'deleted\r\n')
    const recorder = new TurnChangeRecorder(storage)
    const started = await recorder.begin({ ...owner, cwd: project, controlledPaths: ['中文 空格.txt', 'delete.txt', 'empty.txt'] })
    await writeFile(join(project, '中文 空格.txt'), 'after\r\n')
    await unlink(join(project, 'delete.txt'))
    await writeFile(join(project, 'empty.txt'), '')
    const result = await recorder.finish(owner, started.recordId)
    expect(result.completion).toBe('completed')
    expect(result.partial).toBe(false)
    expect(result.coverage).toEqual({ mode: 'controlled-only', externalWrites: 'not-observed' })
    expect(result.files.map(file => [file.path, file.kind, file.source])).toEqual([
      ['中文 空格.txt', 'modified', 'controlled-tool'], ['delete.txt', 'deleted', 'controlled-tool'], ['empty.txt', 'added', 'controlled-tool'],
    ])
    expect(await recorder.store.readText(owner, result.recordId, '中文 空格.txt', 'before')).toBe('\uFEFFbefore\r\n')
    expect(await recorder.store.readText(owner, result.recordId, '中文 空格.txt', 'after')).toBe('after\r\n')
    expect(await recorder.store.readText(owner, result.recordId, 'empty.txt', 'after')).toBe('')
    expect(recorder.activeCount).toBe(0)
    expect(await new TurnChangeStore(storage).read(owner, result.recordId)).toEqual(result)
    await expect(recorder.store.read({ ...owner, sessionId: 'other' }, result.recordId)).rejects.toThrow('会话')
    await expect(recorder.store.read({ ...owner, workspaceId: 'other' }, result.recordId)).rejects.toThrow('会话')
    await expect(recorder.store.read({ ...owner, turnId: 'other' }, result.recordId)).rejects.toThrow('会话')
    const saved = await readFile(join(storage, result.recordId, 'record.json'), 'utf8')
    expect(saved).not.toContain('before\\r\\n')
  })

  test('Given 未变化文件和缺失文件 When 完成本轮 Then 不伪造改动或扫描未知 Shell 文件', async () => {
    const { project, storage } = await fixture()
    await writeFile(join(project, 'same.txt'), 'same')
    const recorder = new TurnChangeRecorder(storage)
    const start = await recorder.begin({ ...owner, cwd: project, controlledPaths: ['same.txt', 'absent.txt'] })
    await writeFile(join(project, 'unknown-shell.txt'), 'not covered')
    const record = await recorder.finish(owner, start.recordId)
    expect(record.files).toEqual([])
    expect(record.coverage.externalWrites).toBe('not-observed')
    expect(record.partial).toBe(false)
  })

  test('Given Git 脏工作树与暂存区 When 记录期间再次编辑 Then 比较轮初内容且不改变暂存区', async () => {
    const { project, storage } = await fixture()
    await repository(project)
    await writeFile(join(project, 'tracked.txt'), 'staged\n')
    git(project, 'add', 'tracked.txt')
    await writeFile(join(project, 'tracked.txt'), 'worktree before\r\n')
    const index = git(project, 'diff', '--cached', '--binary')
    const recorder = new TurnChangeRecorder(storage)
    const start = await recorder.begin({ ...owner, cwd: project })
    await recorder.captureBefore(owner, start.recordId, 'added.txt')
    await writeFile(join(project, 'tracked.txt'), 'worktree after\r\n')
    await writeFile(join(project, 'added.txt'), 'new\n')
    await unlink(join(project, 'deleted.txt'))
    const result = await recorder.finish(owner, start.recordId)
    expect(result.coverage.mode).toBe('git-observed')
    expect(result.files.find(file => file.path === 'tracked.txt')).toMatchObject({ kind: 'modified', source: 'git-observed' })
    expect(result.files.find(file => file.path === 'added.txt')).toMatchObject({ kind: 'added', source: 'controlled-tool' })
    expect(result.files.find(file => file.path === 'deleted.txt')?.kind).toBe('deleted')
    expect(await recorder.store.readText(owner, result.recordId, 'tracked.txt', 'before')).toBe('worktree before\r\n')
    expect(git(project, 'diff', '--cached', '--binary')).toBe(index)
    expect(result.partial).toBe(false)
  })

  test('Given 初始被 Git 忽略的文件 When 本轮解除忽略 Then 标注轮初未知而非错误声称新增', async () => {
    const { project, storage } = await fixture()
    await repository(project)
    await writeFile(join(project, '.gitignore'), 'private.txt\n')
    await writeFile(join(project, 'private.txt'), 'already existed')
    const recorder = new TurnChangeRecorder(storage)
    const start = await recorder.begin({ ...owner, cwd: project })
    await writeFile(join(project, '.gitignore'), '')
    const result = await recorder.finish(owner, start.recordId)
    expect(result.files.find(file => file.path === 'private.txt')).toMatchObject({ kind: 'unknown', before: { availability: 'omitted', reason: 'not-captured' } })
    expect(result.partial).toBe(true)
    expect(result.limitations).toContain('not-captured')
  })

  test('Given Git 仓库中的授权子目录 When 捕获 Then 不包含兄弟目录文件', async () => {
    const { project, storage } = await fixture()
    await repository(project)
    const nested = join(project, 'nested')
    await mkdir(nested)
    await writeFile(join(nested, 'inside.txt'), 'before')
    const recorder = new TurnChangeRecorder(storage)
    const start = await recorder.begin({ ...owner, cwd: nested })
    await writeFile(join(nested, 'inside.txt'), 'after')
    await writeFile(join(project, 'tracked.txt'), 'outside authorized root')
    const record = await recorder.finish(owner, start.recordId)
    expect(record.files.map(file => file.path)).toEqual(['inside.txt'])
  })

  test('Given linked worktree When 捕获本轮 Then 使用该 worktree 内容且不写 Git 元数据', async () => {
    const { project, storage, root } = await fixture()
    await repository(project)
    const worktree = join(root, 'linked worktree')
    git(project, 'worktree', 'add', '-b', 'turn-fixture', worktree)
    const recorder = new TurnChangeRecorder(storage)
    const start = await recorder.begin({ ...owner, cwd: worktree })
    await writeFile(join(worktree, 'tracked.txt'), 'worktree only')
    const result = await recorder.finish(owner, start.recordId)
    expect(result.files.map(file => file.path)).toEqual(['tracked.txt'])
    expect(await readFile(join(project, 'tracked.txt'), 'utf8')).toBe('committed\n')
  })

  test('Given 二进制、超大文件与普通文件 When 捕获 Then 二进制不作文本且超限原因明确', async () => {
    const { project, storage } = await fixture()
    await writeFile(join(project, 'binary.bin'), Buffer.from([0, 1, 2]))
    await writeFile(join(project, 'large.txt'), '123456789')
    await writeFile(join(project, 'normal.txt'), 'a')
    const recorder = new TurnChangeRecorder(storage, { maxFileBytes: 8 })
    const start = await recorder.begin({ ...owner, cwd: project, controlledPaths: ['binary.bin', 'large.txt', 'normal.txt'] })
    await writeFile(join(project, 'binary.bin'), Buffer.from([0, 2, 3]))
    await writeFile(join(project, 'normal.txt'), 'b')
    const record = await recorder.finish(owner, start.recordId)
    expect(record.files.find(file => file.path === 'binary.bin')?.after.format).toBe('binary')
    expect(record.files.find(file => file.path === 'large.txt')?.before.reason).toBe('too-large')
    expect(record.limitations).toContain('too-large')
    await expect(recorder.store.readText(owner, record.recordId, 'binary.bin', 'after')).rejects.toThrow('文本')
    expect(await recorder.store.readText(owner, record.recordId, 'normal.txt', 'after')).toBe('b')
  })

  test('Given 文件数量和总字节限额 When 超限 Then 记录 partial 且不无限读取', async () => {
    const { project, storage } = await fixture()
    for (const name of ['a.txt', 'b.txt', 'c.txt']) await writeFile(join(project, name), 'abc')
    const recorder = new TurnChangeRecorder(storage, { maxFiles: 2, maxSnapshotBytes: 6 })
    const start = await recorder.begin({ ...owner, cwd: project, controlledPaths: ['a.txt', 'b.txt', 'c.txt'] })
    const record = await recorder.finish(owner, start.recordId)
    expect(record.files.length).toBe(2)
    expect(record.limitations).toContain('file-limit')
    expect(record.limitations).toContain('budget-exceeded')
    expect(record.partial).toBe(true)
    expect(record.files.every(file => file.after.reason === 'budget-exceeded')).toBe(true)
    expect(await recorder.store.readText(owner, record.recordId, 'a.txt', 'before')).toBe('abc')
  })

  test('Given Git 输出超过预算 When 发现文件 Then 返回可见的降级原因', async () => {
    const { project, storage } = await fixture()
    await repository(project)
    const recorder = new TurnChangeRecorder(storage, { maxGitOutputBytes: 1 })
    const start = await recorder.begin({ ...owner, cwd: project, controlledPaths: ['tracked.txt'] })
    await writeFile(join(project, 'tracked.txt'), 'after')
    const record = await recorder.finish(owner, start.recordId)
    expect(record.limitations).toContain('git-output-limit')
    expect(record.partial).toBe(true)
    expect(record.files[0]?.source).toBe('controlled-tool')
  })

  test('Given 越界路径与指向根外的目录联接 When 捕获 Then 不读取根外内容', async () => {
    const { project, storage, root } = await fixture()
    const outside = join(root, 'outside')
    await mkdir(outside)
    await writeFile(join(outside, 'secret.txt'), 'secret outside')
    await symlink(outside, join(project, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
    const recorder = new TurnChangeRecorder(storage)
    await expect(recorder.begin({ ...owner, cwd: project, controlledPaths: ['../outside/secret.txt'] })).rejects.toThrow('路径')
    const start = await recorder.begin({ ...owner, cwd: project, controlledPaths: ['linked/secret.txt'] })
    const record = await recorder.finish(owner, start.recordId)
    expect(record.files[0]?.before.reason).toBe('unsafe-path')
    expect(record.files[0]?.after.reason).toBe('unsafe-path')
    const snapshots = await readdir(join(storage, record.recordId, 'snapshots'))
    expect(snapshots).toEqual([])
    expect(recorder.activeCount).toBe(0)
  })

  test('Given 并发受控捕获与重复结束 When 排队执行 Then before 只读一次且旧请求不覆盖终态', async () => {
    const { project, storage } = await fixture()
    await writeFile(join(project, 'x.txt'), '1234')
    const recorder = new TurnChangeRecorder(storage, { maxSnapshotBytes: 8 })
    const start = await recorder.begin({ ...owner, cwd: project })
    await Promise.all([recorder.captureBefore(owner, start.recordId, 'x.txt'), recorder.captureBefore(owner, start.recordId, 'x.txt')])
    await writeFile(join(project, 'x.txt'), '5678')
    const [first, second] = await Promise.allSettled([recorder.finish(owner, start.recordId), recorder.finish(owner, start.recordId)])
    expect(first.status).toBe('fulfilled')
    expect(second.status).toBe('rejected')
    if (first.status === 'fulfilled') expect(first.value).toMatchObject({ completion: 'completed', partial: false })
    expect(recorder.activeCount).toBe(0)
    await expect(recorder.captureBefore(owner, start.recordId, 'x.txt')).rejects.toThrow('不存在')
  })

  test('Given 重复轮次或其他会话 When 访问活动记录 Then 拒绝交叉操作', async () => {
    const { project, storage } = await fixture()
    const recorder = new TurnChangeRecorder(storage)
    const start = await recorder.begin({ ...owner, cwd: project })
    await expect(recorder.begin({ ...owner, cwd: project })).rejects.toThrow('已经开始')
    await expect(recorder.finish({ ...owner, workspaceId: 'other' }, start.recordId)).rejects.toThrow('归属')
    await expect(recorder.captureBefore({ ...owner, sessionId: 'other' }, start.recordId, 'x.txt')).rejects.toThrow('归属')
    expect(recorder.activeCount).toBe(1)
    await recorder.finish(owner, start.recordId, 'cancelled')
  })

  test('Given 预先取消或完成前取消 When 收束记录 Then 不发送后续捕获并释放活动引用', async () => {
    const { project, storage } = await fixture()
    await writeFile(join(project, 'x.txt'), 'before')
    const controller = new AbortController()
    controller.abort()
    const recorder = new TurnChangeRecorder(storage)
    await expect(recorder.begin({ ...owner, cwd: project }, controller.signal)).rejects.toBeDefined()
    expect(recorder.activeCount).toBe(0)
    const start = await recorder.begin({ ...owner, cwd: project, controlledPaths: ['x.txt'] })
    const record = await recorder.finish(owner, start.recordId, 'completed', controller.signal)
    expect(record.completion).toBe('cancelled')
    expect(record.partial).toBe(true)
    expect(record.files[0]?.after.reason).toBe('not-captured')
    expect(await recorder.store.readText(owner, record.recordId, 'x.txt', 'before')).toBe('before')
    expect(recorder.activeCount).toBe(0)
  })

  test('Given 持久化内容损坏或引用被替换 When 查询 Then 拒绝而不返回错误文件', async () => {
    const { project, storage } = await fixture()
    const recorder = new TurnChangeRecorder(storage)
    const start = await recorder.begin({ ...owner, cwd: project, controlledPaths: ['x.txt'] })
    await writeFile(join(project, 'x.txt'), 'after')
    const record = await recorder.finish(owner, start.recordId)
    const hash = record.files[0]!.after.hash!
    await writeFile(join(storage, record.recordId, 'snapshots', hash), 'wrong')
    await expect(recorder.store.readText(owner, record.recordId, 'x.txt', 'after')).rejects.toThrow('完整性')
    const poisoned = structuredClone(record)
    poisoned.files[0]!.after.hash = '../../outside'
    writeTextFileAtomic(join(storage, record.recordId, 'record.json'), JSON.stringify(poisoned))
    await expect(recorder.store.read(owner, record.recordId)).rejects.toThrow('会话')
  })

  test('Given 快照目录被换成联接 When 读取 Then 拒绝进入其他目录', async () => {
    const { project, storage, root } = await fixture()
    const recorder = new TurnChangeRecorder(storage)
    const start = await recorder.begin({ ...owner, cwd: project, controlledPaths: ['x.txt'] })
    await writeFile(join(project, 'x.txt'), 'after')
    const record = await recorder.finish(owner, start.recordId)
    const original = join(storage, record.recordId, 'snapshots')
    const moved = join(root, 'moved-blobs')
    await rename(original, moved)
    await symlink(moved, original, process.platform === 'win32' ? 'junction' : 'dir')
    await expect(recorder.store.readText(owner, record.recordId, 'x.txt', 'after')).rejects.toThrow('越界')
    expect(await readFile(join(moved, record.files[0]!.after.hash!), 'utf8')).toBe('after')
  })

  test('Given 存储根不可用 When begin 失败 Then 不保留活跃轮次', async () => {
    const { project, storage } = await fixture()
    await writeFile(storage, 'not a directory')
    const recorder = new TurnChangeRecorder(storage)
    await expect(recorder.begin({ ...owner, cwd: project })).rejects.toBeDefined()
    expect(recorder.activeCount).toBe(0)
    expect(await readFile(storage, 'utf8')).toBe('not a directory')
  })

  test('Given 非法限额或 Windows 特殊路径 When 开始捕获 Then 提前拒绝', () => {
    for (const path of ['../x', '/etc/passwd', 'C:\\private.txt', 'C:relative.txt', '.git/config', 'x//y', 'x/./y', 'x/../y']) expect(() => normalizeTurnPath(path)).toThrow()
    for (const limits of [{ maxFiles: 0 }, { maxFiles: 2001 }, { maxFileBytes: Infinity }, { maxSnapshotBytes: -1 }, { gitTimeoutMs: 30_001 }]) expect(() => validateTurnLimits(limits)).toThrow()
    expect(normalizeTurnPath('目录\\some..file.txt')).toBe('目录/some..file.txt')
  })
})
