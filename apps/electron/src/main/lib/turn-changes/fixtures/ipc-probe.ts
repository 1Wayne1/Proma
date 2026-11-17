import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { TURN_CHANGES_IPC_CHANNELS } from '@proma/shared'
import { registerTurnChangesIpcHandlers } from '../ipc'
import { withTurnChangesPermission } from '../run'
import { createTurnChangesRun, finishTurnChangesRun, getTurnChangeRecorder, hasActiveTurnChanges, abortSessionTurnChanges, abortAllTurnChanges, drainTurnChanges } from '../service'
import { PiUtilityAdapter } from '../../adapters/pi-utility-adapter'
import '../../../../preload/index'
import { app, getApi, invokeAs, sender, state } from './ipc-host'

async function verify(): Promise<void> {
  const root = process.argv[2]!
  state.configRoot = root
  const project = join(root, 'project')
  await mkdir(project)
  state.target = join(project, '中文.txt')
  await writeFile(state.target, 'before fixture utility')
  const recorder = getTurnChangeRecorder()
  registerTurnChangesIpcHandlers()
  const api = getApi()
  let changed = 0
  const release = api.onTurnChangesChanged(() => { changed += 1 })
  const owner = { sessionId: 'fixture-session', workspaceId: 'fixture-workspace', turnId: 'u1' }
  const run = createTurnChangesRun({ owner, root: project, toolCwd: project, isCurrent: () => true }, 1)
  await run.advance('u1')
  const adapter = new PiUtilityAdapter()
  for await (const _message of adapter.query({
    sessionId: owner.sessionId, prompt: 'fixture', cwd: project, provider: 'custom', apiKey: 'not-sent',
    piAgentDir: root, piSessionDir: root, permissionMode: 'bypassPermissions', systemPrompt: 'fixture',
    onUserTurnStarted: uuid => { void run.advance(uuid) },
    canUseTool: withTurnChangesPermission(async () => ({ behavior: 'allow' }), () => run, () => true),
  })) { throw new Error('fixture should not emit SDK messages') }
  await finishTurnChangesRun(run, 'completed')
  assert.equal(state.stopped, 1)
  assert.equal(recorder.activeCount, 0)
  assert.equal(hasActiveTurnChanges(), false)
  assert.equal(changed, 4)
  release()
  const late = createTurnChangesRun({ owner: { ...owner, turnId: 'u3' }, root: project, toolCwd: project, isCurrent: () => true }, 2)
  await late.advance('u3')
  assert.equal(abortSessionTurnChanges(owner.sessionId, 1).length, 0)
  await late.before('Read', {}, new AbortController().signal)
  assert.deepEqual(abortSessionTurnChanges(owner.sessionId, 2), [late])
  await finishTurnChangesRun(late, 'cancelled')
  assert.equal(changed, 4)
  const retryOwner = { ...owner, turnId: 'retry-input' }
  const older = createTurnChangesRun({ owner: retryOwner, root: project, toolCwd: project, isCurrent: () => true }, 3)
  await older.advance('retry-input')
  const replacement = createTurnChangesRun({ owner: retryOwner, root: project, toolCwd: project, isCurrent: () => true }, 4)
  await replacement.advance('retry-input')
  assert.equal(recorder.activeCount, 1)
  assert.equal(abortSessionTurnChanges(owner.sessionId, 3).length, 0)
  await finishTurnChangesRun(replacement, 'completed')
  const retryRecords = await recorder.store.list(retryOwner)
  assert.deepEqual(retryRecords.map(record => record.completion), ['completed', 'cancelled'])
  const exiting = createTurnChangesRun({ owner: { ...owner, turnId: 'u4' }, root: project, toolCwd: project, isCurrent: () => true }, 3)
  await exiting.advance('u4')
  const stale = createTurnChangesRun({ owner: { ...owner, turnId: 'stale' }, root: project, toolCwd: project, isCurrent: () => false }, 2)
  await stale.advance('stale')
  await exiting.before('Read', {}, new AbortController().signal)
  await finishTurnChangesRun(stale, 'cancelled')
  abortAllTurnChanges()
  await drainTurnChanges()
  assert.equal(hasActiveTurnChanges(), false)
  assert.equal(recorder.activeCount, 0)
  const query = { sessionId: owner.sessionId, turnId: 'u2' }
  const records = await api.getTurnChanges(query)
  assert.equal(records.length, 1)
  assert.equal(records[0]?.completion, 'completed')
  assert.equal(records[0]?.files[0]?.kind, 'modified')
  await writeFile(state.target, 'later disk contents must not replace snapshots')
  const diff = await api.getTurnFileDiff({ ...query, recordId: records[0]!.recordId, path: '中文.txt' })
  assert.equal(diff.before.content, 'before fixture utility')
  assert.equal(diff.after.content, 'written by fixture utility')
  await assert.rejects(invokeAs(TURN_CHANGES_IPC_CHANNELS.LIST, { sender, senderFrame: {} }, query), /主窗口/)
  await assert.rejects(api.getTurnFileDiff({ ...query, recordId: records[0]!.recordId, path: '../outside' }))
  await assert.rejects(api.getTurnFileDiff({ ...query, turnId: 'u1', recordId: records[0]!.recordId, path: '中文.txt' }))
  state.sessionAvailable = false
  await assert.rejects(api.getTurnChanges(query))
  app.emit('will-quit')
  await assert.rejects(api.getTurnChanges(query), /registered/)
  console.log('turn-changes-ipc: passed')
}
verify().catch(error => { console.error(error); process.exitCode = 1 })
