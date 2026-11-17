import { afterEach, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { removeProjectWorktree } from './worktree-removal'
import { assertNoProjectMutation } from './project-mutation-guard'

const roots: string[] = []
function git(cwd: string, ...args: string[]): string { return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }) }
async function fixture(nested = false) {
  const root = await mkdtemp(join(tmpdir(), 'proma-worktree-remove-'))
  roots.push(root)
  const main = join(root, 'repo')
  await mkdir(main)
  git(main, 'init'); git(main, 'config', 'user.name', 'Fixture'); git(main, 'config', 'user.email', 'fixture@proma.local')
  await writeFile(join(main, '.gitignore'), 'ignored.tmp\n.worktrees/\n')
  await writeFile(join(main, 'tracked.txt'), 'tracked')
  git(main, 'add', '.'); git(main, 'commit', '-m', 'fixture')
  const worktree = nested ? join(main, '.worktrees', '中文 空格') : join(root, '中文 空格')
  git(main, 'worktree', 'add', '-b', 'test-branch', worktree)
  const state = { busy: false, referenced: false, authorized: true, cleaned: 0 }
  const options = { authorize: async () => state.authorized, isBusy: () => state.busy, isReferenced: () => state.referenced, onRemoved: async () => { state.cleaned++; return ['idle-session'] } }
  return { root, main, worktree, state, options, input: { sessionId: 'session', worktreePath: worktree } }
}
afterEach(async () => {
  for (const root of roots.splice(0)) {
    if (dirname(resolve(root)) !== resolve(tmpdir())) throw new Error('临时根越界')
    await rm(root, { recursive: true, force: true })
  }
})
test('Given 干净 linked worktree When 确认移除 Then Git 删除目录但保留分支并释放引用', async () => {
  for (const nested of [false, true]) {
    const f = await fixture(nested)
    const index = await readFile(join(f.main, '.git/index'))
    const result = await removeProjectWorktree(f.input, f.options)
    expect(result.clearedSessionIds).toEqual(['idle-session'])
    expect(git(f.main, 'branch', '--list', 'test-branch')).toContain('test-branch')
    expect(git(f.main, 'worktree', 'list', '--porcelain')).not.toContain('中文 空格')
    expect(await readFile(join(f.main, '.git/index'))).toEqual(index)
    expect(f.state.cleaned).toBe(1)
  }
})
test('Given tracked、untracked 或 ignored 文件 When 移除 Then 拒绝并保留文件', async () => {
  for (const path of ['tracked.txt', 'untracked.txt', 'ignored.tmp']) {
    const f = await fixture()
    await writeFile(join(f.worktree, path), 'user data')
    await expect(removeProjectWorktree(f.input, f.options)).rejects.toThrow('文件')
    expect(await readFile(join(f.worktree, path), 'utf8')).toBe('user data')
    expect(f.state.cleaned).toBe(0)
  }
})
test('Given 活动任务或持久资源引用 When 移除 Then 请求在 Git 删除前被阻止', async () => {
  const f = await fixture()
  f.state.busy = true
  await expect(removeProjectWorktree(f.input, f.options)).rejects.toThrow('活动')
  f.state.busy = false; f.state.referenced = true
  await expect(removeProjectWorktree(f.input, f.options)).rejects.toThrow('关联')
  expect(await readFile(join(f.worktree, 'tracked.txt'), 'utf8')).toBe('tracked')
})
test('Given 主仓库、子目录和未授权 worktree When 移除 Then 不扩大删除目标', async () => {
  const f = await fixture()
  await expect(removeProjectWorktree({ ...f.input, worktreePath: f.main }, f.options)).rejects.toBeDefined()
  await mkdir(join(f.worktree, 'subdir'))
  await expect(removeProjectWorktree({ ...f.input, worktreePath: join(f.worktree, 'subdir') }, f.options)).rejects.toBeDefined()
  f.state.authorized = false
  await expect(removeProjectWorktree(f.input, f.options)).rejects.toThrow('无权')
  expect(await readFile(join(f.worktree, 'tracked.txt'), 'utf8')).toBe('tracked')
})
test('Given 锁定 worktree 或路径联接 When 移除 Then 不解锁也不跟随链接删除', async () => {
  const f = await fixture()
  git(f.main, 'worktree', 'lock', f.worktree)
  await expect(removeProjectWorktree(f.input, f.options)).rejects.toThrow('锁定')
  git(f.main, 'worktree', 'unlock', f.worktree)
  const alias = join(f.root, 'alias')
  await symlink(f.worktree, alias, process.platform === 'win32' ? 'junction' : 'dir')
  await expect(removeProjectWorktree({ ...f.input, worktreePath: alias }, f.options)).rejects.toThrow('联接')
  expect(await readFile(join(f.worktree, 'tracked.txt'), 'utf8')).toBe('tracked')
})
test('Given 异步检查期间任务启动或授权改变 When 最终删除 Then 再次检查并释放操作锁', async () => {
  const f = await fixture()
  let calls = 0
  const options = { ...f.options, authorize: async () => { if (++calls === 2) f.state.busy = true; return true } }
  await expect(removeProjectWorktree(f.input, options)).rejects.toThrow('活动')
  assertNoProjectMutation([f.worktree])
  expect(await readFile(join(f.worktree, 'tracked.txt'), 'utf8')).toBe('tracked')
})
test('Given 目录已由 Git 移除但引用清理失败 When 返回 Then 明确报告已删除与待处理引用', async () => {
  const f = await fixture()
  const result = await removeProjectWorktree(f.input, { ...f.options, onRemoved: async () => { throw new Error('fixture failure') } })
  expect(result.warnings?.[0]).toContain('目录已移除')
  expect(await readdir(f.root)).not.toContain('中文 空格')
})
