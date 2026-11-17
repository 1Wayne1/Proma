import { spawn } from 'node:child_process'
import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createHash } from 'node:crypto'
import type { RemoveWorktreeInput, RemoveWorktreeResult } from '@proma/shared'
import { withProjectMutation } from './project-mutation-guard'
import { assertRestoreRoot, restoreRootIdentity } from './turn-changes/restore-files'
import { isWithinTurnRoot, turnPathKey } from './turn-changes/paths'

export interface WorktreeRemovalOptions {
  authorize: (sessionId: string, root: string) => Promise<boolean>
  isBusy: (root: string) => boolean
  isReferenced: (root: string) => boolean
  onRemoved: (root: string) => Promise<string[]>
  assertCurrent?: () => void
}

/** 失败、超时和超量都不能被误判为干净目录。 */
function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['-C', cwd, ...args], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let size = 0
    let failure: Error | undefined
    const timer = setTimeout(() => { failure = new Error('Git 操作超时'); child.kill() }, 15_000)
    const receive = (chunks: Buffer[], data: Buffer): void => {
      size += data.length
      if (size > 2 * 1024 * 1024) { failure = new Error('Git 输出超过安全限额'); child.kill(); return }
      chunks.push(data)
    }
    child.stdout.on('data', (data: Buffer) => receive(stdout, data))
    child.stderr.on('data', (data: Buffer) => receive(stderr, data))
    child.on('error', error => { clearTimeout(timer); reject(error) })
    child.on('close', code => {
      clearTimeout(timer)
      if (failure || code !== 0) reject(failure ?? new Error(`Git 拒绝操作：${Buffer.concat(stderr).toString('utf8').trim().slice(0, 500)}`))
      else resolve(Buffer.concat(stdout).toString('utf8'))
    })
  })
}

function gitFileIdentity(root: string): string {
  const path = join(root, '.git')
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8192 || realpathSync(path) !== path) throw new Error('目标不是普通 linked worktree')
  return `${stat.dev}:${stat.ino}:${createHash('sha256').update(readFileSync(path)).digest('hex')}`
}

/** 不提供 force，也不删除分支；忽略文件同样必须先由用户处理。 */
export async function removeProjectWorktree(input: RemoveWorktreeInput, options: WorktreeRemovalOptions): Promise<RemoveWorktreeResult> {
  if (!input || typeof input.sessionId !== 'string' || !input.sessionId || input.sessionId.length > 256 || input.sessionId.includes('\0') || typeof input.worktreePath !== 'string' || !input.worktreePath || input.worktreePath.includes('\0')) throw new Error('无效的 worktree 移除请求')
  const root = realpathSync(input.worktreePath)
  if (lstatSync(input.worktreePath).isSymbolicLink()) throw new Error('不能通过目录联接移除 worktree')
  const identity = restoreRootIdentity(root)
  const gitIdentity = gitFileIdentity(root)
  return withProjectMutation(root, async () => {
    const check = (): void => {
      options.assertCurrent?.()
      assertRestoreRoot(root, identity)
      if (gitFileIdentity(root) !== gitIdentity) throw new Error('worktree 身份已改变')
      if (options.isBusy(root)) throw new Error('worktree 有活动会话、队列或终端，请先结束它们')
      if (options.isReferenced(root)) throw new Error('请先解除该 worktree 内的项目根或附加文件/目录关联')
    }
    check()
    if (!await options.authorize(input.sessionId, root)) throw new Error('无权移除该 worktree')
    const toplevel = realpathSync((await git(root, ['rev-parse', '--show-toplevel'])).trim())
    if (turnPathKey(toplevel) !== turnPathKey(root)) throw new Error('必须指定 worktree 根目录')
    const common = realpathSync((await git(root, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim())
    const main = realpathSync(dirname(common))
    if (turnPathKey(main) === turnPathKey(root) || isWithinTurnRoot(root, main)) throw new Error('不能移除主仓库或包含主仓库的目录')
    const verifyEntry = async (): Promise<void> => {
      const list = await git(main, ['worktree', 'list', '--porcelain', '-z'])
      const entry = list.split('\0\0').map(block => block.split('\0')).find(fields => fields.some(field => field.startsWith('worktree ') && turnPathKey(field.slice(9)) === turnPathKey(root.replace(/\\/g, '/'))))
      if (!entry || entry.some(field => field.startsWith('locked') || field.startsWith('prunable'))) throw new Error('worktree 不存在、已锁定或待清理')
    }
    await verifyEntry()
    if ((await git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored=matching'])).length > 0) throw new Error('worktree 含未提交、未跟踪或被忽略的文件，请先处理后再移除')
    if (!await options.authorize(input.sessionId, root)) throw new Error('项目授权已改变')
    await verifyEntry()
    check()
    await git(main, ['worktree', 'remove', '--', root])
    try { return { path: root, clearedSessionIds: await options.onRemoved(root) } }
    catch { return { path: root, clearedSessionIds: [], warnings: ['目录已移除，但部分会话或观察引用未清理，请刷新并检查会话设置'] } }
  })
}
