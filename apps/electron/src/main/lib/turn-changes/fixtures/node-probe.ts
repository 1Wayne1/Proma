import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { TurnChangeRecorder } from '../recorder'

async function verify(): Promise<void> {
  const root = process.argv[2]!
  const project = join(root, 'node-project')
  await mkdir(project)
  await writeFile(join(project, '中文.txt'), 'node before\r\n')
  const recorder = new TurnChangeRecorder(join(root, 'node-snapshots'))
  const owner = { sessionId: 'node-session', turnId: 'node-turn', workspaceId: 'node-workspace' }
  const begin = await recorder.begin({ ...owner, cwd: project, controlledPaths: ['中文.txt'] })
  await recorder.captureBefore(owner, begin.recordId, 'empty.txt')
  await writeFile(join(project, '中文.txt'), 'node after\r\n')
  await writeFile(join(project, 'empty.txt'), '')
  const record = await recorder.finish(owner, begin.recordId)
  assert.equal(record.completion, 'completed')
  assert.equal(record.partial, false)
  assert.deepEqual(record.files.map(file => file.kind), ['modified', 'added'])
  assert.equal(await recorder.store.readText(owner, record.recordId, '中文.txt', 'before'), 'node before\r\n')
  assert.equal(await recorder.store.readText(owner, record.recordId, 'empty.txt', 'after'), '')
  assert.equal(recorder.activeCount, 0)
  console.log('turn-changes-node: passed')
}

verify().catch(error => { console.error(error); process.exitCode = 1 })
