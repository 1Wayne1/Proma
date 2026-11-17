import { afterEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { TurnChangeRecorder } from './recorder'
import { TurnChangesQueries } from './query'
import { writeTextFileAtomic } from '../safe-file'

const roots: string[] = []
const owner = { sessionId: 'session', workspaceId: 'workspace', turnId: 'turn' }

test('Given 未收束的轮初快照 When 界面查询 Then 不把候选文件冒充已发生的变更', async () => {
  const f = await fixture()
  await writeFile(join(f.project, 'x.txt'), 'before')
  const start = await f.recorder.begin({ ...owner, cwd: f.project, controlledPaths: ['x.txt'] })
  const [record] = await f.queries.list(owner)
  expect(record?.completion).toBe('recording')
  expect(record?.files).toEqual([])
  expect(record?.partial).toBe(true)
  expect((await f.recorder.store.read(owner, start.recordId)).files.length).toBe(1)
  await expect(f.queries.diff({ ...owner, recordId: start.recordId, path: 'x.txt' })).rejects.toThrow('收束')
  await f.recorder.finish(owner, start.recordId, 'cancelled')
})
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'proma-turn-query-'))
  roots.push(root)
  const project = join(root, 'project')
  await mkdir(project)
  const recorder = new TurnChangeRecorder(join(root, 'snapshots'))
  const queries = new TurnChangesQueries(recorder.store, id => id === owner.sessionId ? owner : undefined)
  return { root, project, recorder, queries }
}
afterEach(async () => {
  for (const root of roots.splice(0)) {
    if (dirname(resolve(root)) !== resolve(tmpdir())) throw new Error('临时根越界')
    await rm(root, { recursive: true, force: true })
  }
})

test('Given 新增文本、二进制与超限文件 When 查询差异 Then 缺失侧为空且不可用侧不冒充空文本', async () => {
  const f = await fixture()
  const start = await f.recorder.begin({ ...owner, cwd: f.project, controlledPaths: ['new.txt', 'binary.bin', 'large.txt'] })
  await writeFile(join(f.project, 'new.txt'), 'text')
  await writeFile(join(f.project, 'binary.bin'), Buffer.from([0, 1]))
  await writeFile(join(f.project, 'large.txt'), Buffer.alloc(1024 * 1024 + 1))
  await f.recorder.finish(owner, start.recordId)
  expect((await f.queries.list(owner))[0]?.recordId).toBe(start.recordId)
  const text = await f.queries.diff({ ...owner, recordId: start.recordId, path: 'new.txt' })
  expect(text.before.content).toBe('')
  expect(text.after.content).toBe('text')
  const binary = await f.queries.diff({ ...owner, recordId: start.recordId, path: 'binary.bin' })
  expect(binary.after.content).toBeUndefined()
  expect(binary.after.snapshot.format).toBe('binary')
  const large = await f.queries.diff({ ...owner, recordId: start.recordId, path: 'large.txt' })
  expect(large.after.content).toBeUndefined()
  expect(large.after.snapshot.reason).toBe('too-large')
})

test('Given 任意路径、其他轮次或其他会话 When 查询 Then 拒绝读取并保留归属边界', async () => {
  const f = await fixture()
  const start = await f.recorder.begin({ ...owner, cwd: f.project, controlledPaths: ['x.txt'] })
  await writeFile(join(f.project, 'x.txt'), 'after')
  await f.recorder.finish(owner, start.recordId)
  await expect(f.queries.diff({ ...owner, recordId: start.recordId, path: '../outside' })).rejects.toBeDefined()
  await expect(f.queries.diff({ ...owner, recordId: start.recordId, path: 'not-recorded.txt' })).rejects.toBeDefined()
  await expect(f.queries.diff({ ...owner, turnId: 'another-turn', recordId: start.recordId, path: 'x.txt' })).rejects.toBeDefined()
  await expect(f.queries.list({ ...owner, sessionId: 'another-session' })).rejects.toBeDefined()
  const wrongWorkspace = new TurnChangesQueries(f.recorder.store, () => ({ ...owner, workspaceId: 'other' }))
  await expect(wrongWorkspace.diff({ ...owner, recordId: start.recordId, path: 'x.txt' })).rejects.toBeDefined()
})

test('Given 查询期间会话删除或迁移 When 数据读取结束 Then 不交付迟到结果', async () => {
  const f = await fixture()
  let calls = 0
  const queries = new TurnChangesQueries(f.recorder.store, () => ++calls === 1 ? owner : undefined)
  await expect(queries.list(owner)).rejects.toThrow('变化')
})

test('Given 同一轮多次执行 When 列出记录 Then 仅返回最近十次且不混入其他输入', async () => {
  const f = await fixture()
  const ids: string[] = []
  for (let i = 0; i < 11; i++) {
    const start = await f.recorder.begin({ ...owner, cwd: f.project })
    ids.push(start.recordId)
    await f.recorder.finish(owner, start.recordId)
  }
  const records = await f.queries.list(owner)
  expect(records.map(record => record.recordId)).toEqual(ids.slice(-10).reverse())
  expect(await f.queries.list({ ...owner, turnId: 'different' })).toEqual([])
  await expect(f.recorder.store.read(owner, ids[0]!)).rejects.toBeDefined()
})

test('Given 持久化记录被篡改 When 查询 Then 不把损坏数据当作无改动', async () => {
  const f = await fixture()
  const start = await f.recorder.begin({ ...owner, cwd: f.project })
  await f.recorder.finish(owner, start.recordId)
  writeTextFileAtomic(join(f.root, 'snapshots', start.recordId, 'record.json'), '{}')
  await expect(f.queries.list(owner)).rejects.toBeDefined()
})
