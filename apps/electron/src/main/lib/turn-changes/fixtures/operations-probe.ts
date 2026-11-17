import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { TURN_CHANGES_IPC_CHANNELS } from '@proma/shared'
import { getApi, invokeAs, sender, state, app, terminalHost } from './operations-host'
import { TurnChangeRecorder } from '../recorder'
import { TurnRestoreService } from '../restore'
import { registerTurnOperationsIpcHandlers } from '../operations-ipc'
import { removeProjectWorktree } from '../../worktree-removal'
import { assertNoProjectMutation, withProjectMutation } from '../../project-mutation-guard'
import { createTerminal, closeAgentTerminal, hasTerminalsInProject, killTerminal, listAgentTerminals, openAgentTerminal, releaseExitedTerminalsInProject } from '../../terminal-service'
import '../../../../preload/index'

async function verify(): Promise<void> {
  const root = process.argv[2]!
  const project = join(root, 'project'); await mkdir(project)
  const owner = { sessionId: 'fixture-session', workspaceId: 'fixture-workspace', turnId: 'turn' }
  const recorder = new TurnChangeRecorder(join(root, 'private'))
  const path = join(project, 'file.txt')
  await writeFile(path, 'before')
  const start = await recorder.begin({ ...owner, cwd: project, controlledPaths: ['file.txt'] })
  await writeFile(path, 'after')
  const record = await recorder.finish(owner, start.recordId)
  let authorize = async (): Promise<boolean> => true
  const restore = new TurnRestoreService(recorder.store, {
    resolveSession: id => id === owner.sessionId && state.sessionAvailable ? { workspaceId: owner.workspaceId, roots: [project], identity: 'fixture' } : undefined,
    authorizeRoot: () => authorize(), isBusy: hasTerminalsInProject,
  })
  registerTurnOperationsIpcHandlers({ restore, removeWorktree: (input, assertCurrent) => removeProjectWorktree(input, {
    assertCurrent, authorize: async () => state.sessionAvailable, isBusy: hasTerminalsInProject, isReferenced: () => false,
    onRemoved: async worktree => { releaseExitedTerminalsInProject(worktree); return ['idle-session'] },
  }) })
  const api = getApi()
  const query = { ...owner, recordId: record.recordId, path: 'file.txt' }
  const preview = await api.previewTurnRestore(query)
  assert.equal(preview.status, 'ready')
  await assert.rejects(invokeAs(TURN_CHANGES_IPC_CHANNELS.APPLY_RESTORE, { sender, senderFrame: {} }, { ...owner, previewId: preview.previewId }), /主窗口/)
  assert.equal((await api.applyTurnRestore({ ...owner, sessionId: 'other', previewId: preview.previewId! })).status, 'expired')
  assert.equal((await api.applyTurnRestore({ ...owner, previewId: preview.previewId! })).status, 'restored')
  assert.equal(await readFile(path, 'utf8'), 'before')
  assert.equal((await api.applyTurnRestore({ ...owner, previewId: preview.previewId! })).status, 'expired')
  await writeFile(path, 'after')
  const staleFrame = await api.previewTurnRestore(query)
  const originalFrame = sender.mainFrame
  authorize = async () => { sender.mainFrame = {}; return true }
  assert.equal((await api.applyTurnRestore({ ...owner, previewId: staleFrame.previewId! })).status, 'failed')
  sender.mainFrame = originalFrame; authorize = async () => true
  assert.equal(await readFile(path, 'utf8'), 'after')

  // 实际 terminal-service 的 pending 归属也参与恢复边界，PTY host 使用本地替身。
  terminalHost.pending = true
  const terminalId = 'pending-terminal'
  const pending = createTerminal({ terminalId, sessionId: owner.sessionId, cwd: project, cols: 80, rows: 24 }, { strictCwd: true })
  assert.equal(hasTerminalsInProject(project), true)
  assert.equal((await api.previewTurnRestore(query)).status, 'busy')
  killTerminal(terminalId)
  terminalHost.resolve!({ terminalId, cwd: project, title: 'fixture', profile: 'default', pid: 1 })
  await assert.rejects(pending, /关闭/)
  assert.equal(hasTerminalsInProject(project), false)
  terminalHost.pending = false
  await withProjectMutation(project, async () => {
    await assert.rejects(createTerminal({ terminalId: 'blocked-terminal', sessionId: owner.sessionId, cwd: project, cols: 80, rows: 24 }), /正在/)
  })
  assertNoProjectMutation([project])

  const main = join(root, 'repo'); await mkdir(main)
  const git = (...args: string[]): string => execFileSync('git', args, { cwd: main, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  git('init'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@proma.local')
  await writeFile(join(main, 'file.txt'), 'tracked'); git('add', '.'); git('commit', '-m', 'fixture')
  const worktree = join(root, 'worktree'); git('worktree', 'add', '-b', 'retained-branch', worktree)
  const terminal = await openAgentTerminal({ sessionId: owner.sessionId, cwd: worktree })
  await assert.rejects(api.removeWorktree({ sessionId: owner.sessionId, worktreePath: worktree }), /活动/)
  terminalHost.exit!({ terminalId: terminal.terminalId, exitCode: 0 })
  assert.equal(listAgentTerminals(owner.sessionId).length, 1)
  const removed = await api.removeWorktree({ sessionId: owner.sessionId, worktreePath: worktree })
  assert.deepEqual(removed.clearedSessionIds, ['idle-session'])
  assert.equal(listAgentTerminals(owner.sessionId).length, 0)
  assert.match(git('branch', '--list', 'retained-branch'), /retained-branch/)
  app.emit('will-quit')
  await assert.rejects(api.previewTurnRestore(query), /not registered/)
  console.log('turn-operations-ipc: passed')
}
void verify().catch(error => { console.error(error); process.exitCode = 1 })
