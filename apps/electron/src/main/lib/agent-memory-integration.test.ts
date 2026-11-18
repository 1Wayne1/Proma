import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { MemoryTarget, MemoryWriteAccess, MemoryWriteResult } from '@proma/shared'
import { AgentMemoryService } from './agent-memory'
import { executeMemoryAction, parseAgentMemoryRequest } from './agent-memory-actions'
import { linkMemoryInstruction, previewMemoryInstruction } from './agent-memory-instructions'
import { applyMemoryMigration, previewMemoryMigration } from './agent-memory-migration'
import { buildPiMemoryTools } from './adapters/pi-memory-tools'
import { writeJsonFileAtomic, writeTextFileAtomic } from './safe-file'
import { TurnChangeRecorder } from './turn-changes/recorder'
import { TurnChangesRun } from './turn-changes/run'

const access: MemoryWriteAccess = { source: 'user', permissionMode: 'bypassPermissions' }

function revision(result: MemoryWriteResult): string {
  if (result.status !== 'saved' || !result.document.revision) throw new Error('预期正文已保存')
  return result.document.revision
}

function writeFixture(root: string, path: string, text: string): void {
  const absolute = join(root, path)
  mkdirSync(dirname(absolute), { recursive: true })
  writeTextFileAtomic(absolute, text)
}

describe('长期记忆接入', () => {
  let root: string
  let config: string
  let project: string
  let attached: string
  let legacy: string
  let service: AgentMemoryService
  let target: MemoryTarget

  beforeEach(() => {
    root = mkdtempSync(join(realpathSync(tmpdir()), 'proma-memory-integration-'))
    config = join(root, 'config')
    project = join(root, 'project')
    attached = join(root, 'attached')
    legacy = join(config, 'agent-workspaces', 'sample')
    for (const directory of [config, project, attached]) mkdirSync(directory)
    writeJsonFileAtomic(join(config, 'agent-workspaces.json'), { version: 2, workspaces: [
      { id: 'sample-id', slug: 'sample', projectRootPath: project, attachedDirectories: [attached] },
      { id: 'other-id', slug: 'other', projectRootPath: attached },
    ] })
    service = new AgentMemoryService(config)
    target = service.resolveTarget({ kind: 'project', workspaceId: 'sample-id' })
  })

  afterEach(() => rmSync(root, { recursive: true, force: true }))

  test('Given 项目、附加目录和全局画像 When 搜索 Then 仅返回指定范围、行号及有界片段', () => {
    const global = service.resolveTarget({ kind: 'global' })
    writeFixture(attached, 'MEMORY.md', '关键词 附加目录')
    service.update(global, access, null, '关键词 全局')
    service.update(target, access, null, `首行\r\n${'甲'.repeat(160)}关键词${'乙'.repeat(260)}`)
    service.update(target, access, null, '关键词 子目录', 'memory/主题/笔记.md')
    const result = service.search(target, '关键词')

    expect(result.hits.map(({ path, line }) => [path, line])).toEqual([['MEMORY.md', 2], ['memory/主题/笔记.md', 1]])
    expect(result.hits[0]?.snippet).toContain('关键词')
    expect(result.hits[0]?.snippet.length).toBeLessThan(244)
    expect(service.search(global, '关键词').hits).toEqual([{ path: 'user_profile.md', line: 1, snippet: '关键词 全局' }])
    expect(() => service.inspect(target, '../attached/MEMORY.md')).toThrow()
  })

  test('Given 多条匹配和不可读取的 Markdown When 搜索 Then 结果明确标注部分覆盖', () => {
    service.update(target, access, null, 'test\n'.repeat(21))
    writeFixture(project, 'memory/过大.md', 'a'.repeat(1024 * 1024 + 1))
    expect(service.search(target, 'TEST')).toMatchObject({ partial: true })
    expect(service.search(target, 'TEST').hits).toHaveLength(20)
    expect(service.search(target, '无匹配')).toEqual({ hits: [], partial: true })
  })

  test('Given 有现行正文的笔记 When 归档、重启和预览恢复 Then 正文仍可从历史精确恢复', () => {
    const path = 'memory/发布.md'
    const old = revision(service.update(target, access, null, '\uFEFF发布流程\r\n', path))
    expect(service.archive(target, access, null, path)).toEqual({ status: 'conflict', currentRevision: old })
    expect(service.archive(target, access, old, path)).toMatchObject({ status: 'saved', document: { revision: null } })
    expect(existsSync(join(project, path))).toBe(false)

    const fresh = new AgentMemoryService(config)
    expect(fresh.list(target).archived).toEqual([path])
    expect(fresh.history(target, path)[0]?.revision).toBe(old)
    const preview = fresh.restorePreview(target, old, path)
    expect(preview.archived.content).toBe('\uFEFF发布流程\r\n')
    expect(preview.current.revision).toBeNull()
    expect(revision(fresh.restore(target, access, preview.current.revision, old, path))).toBe(old)
    expect(fresh.list(target).archived).toEqual([])
    expect(fresh.list(target).files).toContain(path)

    const archiveMarkers = join(config, 'agent-memory', 'archived', target.id)
    const marker = readdirSync(archiveMarkers)[0]
    if (!marker) throw new Error('归档索引未保存')
    writeFixture(archiveMarkers, marker, '{}')
    expect(() => fresh.archive(target, access, old, path)).toThrow('归档索引损坏')
    expect(fresh.inspect(target, path).revision).toBe(old)
  })

  test('Given 旧路径、已有新正文及坏文件 When 预览并导入 Then 仅复制有效空目标，逐项保留来源与备份', () => {
    writeFixture(legacy, 'memory/MEMORY.md', '旧索引')
    writeFixture(legacy, 'memory/流程.md', '旧文件正文')
    writeFixture(legacy, '.claude/memory/有冲突.md', '旧冲突')
    writeFixture(legacy, '.claude/memory/损坏.md', 'a\0b')
    writeFixture(legacy, 'memory/raw.bin', '非 Markdown')
    writeFixture(project, 'AGENTS.md', '项目原规则')
    service.update(target, access, null, '用户新预期', 'memory/有冲突.md')
    const preview = previewMemoryMigration(service, target)
    expect(existsSync(join(config, 'agent-memory'))).toBe(false)
    expect(preview.items.map((item) => item.status)).toEqual(['ready', 'unsupported', 'ready', 'unsupported', 'conflict'])

    const applied = applyMemoryMigration(service, target, access, preview.id)
    expect(applied.items.filter((item) => item.status === 'imported')).toHaveLength(2)
    expect(service.inspect(target).content).toBe('旧索引')
    expect(service.inspect(target, 'memory/有冲突.md').content).toBe('用户新预期')
    expect(readFileSync(join(legacy, 'memory/MEMORY.md'), 'utf8')).toBe('旧索引')
    expect(readFileSync(join(project, 'AGENTS.md'), 'utf8')).toBe('项目原规则')
    const backups = join(config, 'agent-memory', 'migrations', target.id)
    expect(readdirSync(backups)).toHaveLength(2)
    expect(readdirSync(backups).map((file) => JSON.parse(readFileSync(join(backups, file), 'utf8')).content)).toContain('旧文件正文')

    const imported = service.inspect(target, 'memory/流程.md')
    service.archive(target, access, imported.revision, 'memory/流程.md')
    const repeat = previewMemoryMigration(new AgentMemoryService(config), target)
    expect(repeat.items.filter((item) => item.status === 'imported')).toHaveLength(2)
    applyMemoryMigration(service, target, access, repeat.id)
    expect(service.inspect(target, 'memory/流程.md').revision).toBeNull()
  })

  test('Given 源正文或目标改变 When 提交旧迁移计划 Then 要求重新预览并保留编辑', () => {
    writeFixture(legacy, 'memory/计划.md', '旧文')
    const first = previewMemoryMigration(service, target)
    writeFixture(legacy, 'memory/计划.md', '已外改')
    expect(() => applyMemoryMigration(service, target, access, first.id)).toThrow('计划已变化')
    expect(service.inspect(target, 'memory/计划.md').content).toBeNull()
    const second = previewMemoryMigration(service, target)
    service.update(target, access, null, '目标新增', 'memory/计划.md')
    expect(() => applyMemoryMigration(service, target, access, second.id)).toThrow('计划已变化')
    expect(service.inspect(target, 'memory/计划.md').content).toBe('目标新增')
  })

  test('Given 旧记忆目录是链接 When 预览 Then 不读取工作区外内容', () => {
    mkdirSync(join(legacy, '.claude'), { recursive: true })
    writeFixture(attached, '机密.md', '外部内容')
    symlinkSync(attached, join(legacy, '.claude', 'memory'), process.platform === 'win32' ? 'junction' : 'dir')
    const preview = previewMemoryMigration(service, target)
    expect(preview.items).toEqual([{ source: 'workspace/.claude/memory', status: 'unsupported' }])
    expect(readdirSync(project)).toEqual([])
  })

  test('Given 用户明确关联项目记忆 When 确认 Then 追加同项目链接且保留指令和 CLAUDE.md', () => {
    service.initialize(target, access)
    const original = '\uFEFF项目约定\r\n已有指令\r\n'
    writeFixture(project, 'AGENTS.md', original)
    writeFixture(project, 'CLAUDE.md', '保留旧指令')
    const first = previewMemoryInstruction(service, target)
    expect(first.linked).toBe(false)
    writeFixture(project, 'AGENTS.md', original + '外部编辑\r\n')
    expect(() => linkMemoryInstruction(service, target, access, first.revision)).toThrow('指令已变化')
    const next = previewMemoryInstruction(service, target)
    expect(linkMemoryInstruction(service, target, access, next.revision).linked).toBe(true)
    const after = previewMemoryInstruction(service, target)
    linkMemoryInstruction(service, target, access, after.revision)
    expect(readFileSync(join(project, 'AGENTS.md'), 'utf8')).toBe(original + '外部编辑\r\n\r\n- [项目记忆](MEMORY.md)\r\n')
    expect(readFileSync(join(project, 'CLAUDE.md'), 'utf8')).toBe('保留旧指令')
  })

  test('Given 项目记忆尚未创建 When Pi 初始化时同时提交正文 Then 保存首版而且重试不覆盖', async () => {
    const tool = buildPiMemoryTools({ workspaceId: 'sample-id', service, isCurrent: () => true, getAccess: () => access })
      .find(({ name }) => name === 'MemoryWrite')
    if (!tool) throw new Error('前台记忆写入工具未注册')
    const context = {} as Parameters<typeof tool.execute>[4]
    const input = { scope: 'project', action: 'initialize', path: 'MEMORY.md', content: '验收记号' }
    await expect(tool.execute('create', input, undefined, undefined, context)).resolves.toMatchObject({
      content: [{ type: 'text', text: expect.stringContaining('"status":"saved"') }],
    })
    const initial = service.inspect(target)
    expect(initial.content).toBe('验收记号')
    await expect(tool.execute('repeat', { ...input, content: '不得覆盖' }, undefined, undefined, context)).resolves.toMatchObject({
      content: [{ type: 'text', text: expect.stringContaining('"status":"conflict"') }],
    })
    expect(service.inspect(target)).toEqual(initial)
  })

  test('Given 前台和无人值守上下文 When 建立 Pi 工具 Then 限制来源、项目、实时权限、信号与代次', async () => {
    service.update(target, access, null, '当前项目')
    const other = service.resolveTarget({ kind: 'project', workspaceId: 'other-id' })
    service.update(other, access, null, '附加目录项目')
    for (const source of ['automation', 'delegation', 'external'] as const) {
      expect(buildPiMemoryTools({ service, workspaceId: 'sample-id', getAccess: () => ({ ...access, source }), isCurrent: () => true })).toEqual([])
    }

    let current = true
    let currentAccess = access
    const [read, write] = buildPiMemoryTools({
      service, workspaceId: 'sample-id', getAccess: () => currentAccess, isCurrent: () => current,
    })
    if (!read || !write) throw new Error('前台记忆工具未注册')
    expect([read.name, write.name]).toEqual(['MemoryRead', 'MemoryWrite'])
    const payload = await read.execute('id', { scope: 'project', action: 'inspect', workspaceId: 'other-id' }, undefined, undefined, {} as Parameters<typeof read.execute>[4])
    expect(payload.content[0]).toMatchObject({ text: expect.stringContaining('当前项目') })
    currentAccess = { ...access, permissionMode: 'plan' }
    await expect(write.execute('id', { scope: 'project', action: 'initialize' }, undefined, undefined, {} as Parameters<typeof write.execute>[4])).rejects.toThrow('没有记忆写入权限')
    await expect(read.execute('id', { scope: 'project', action: 'initialize' }, undefined, undefined, {} as Parameters<typeof read.execute>[4])).rejects.toThrow('权限不匹配')
    currentAccess = access
    await expect(read.execute('id', { scope: 'project', action: 'inspect' }, AbortSignal.abort(), undefined, {} as Parameters<typeof read.execute>[4])).rejects.toThrow('取消')
    current = false
    await expect(read.execute('id', { scope: 'project', action: 'inspect' }, undefined, undefined, {} as Parameters<typeof read.execute>[4])).rejects.toThrow('归属已改变')
  })

  test('Given Pi 执行期间主项目被替换 When 调用旧绑定 Then 拒绝访问新目录', async () => {
    const [tool] = buildPiMemoryTools({ service, workspaceId: 'sample-id', getAccess: () => access, isCurrent: () => true })
    if (!tool) throw new Error('前台记忆工具未注册')
    renameSync(project, join(root, 'old-project'))
    mkdirSync(project)
    writeFixture(project, 'MEMORY.md', '替换目录')
    await expect(tool.execute('id', { scope: 'project', action: 'inspect' }, undefined, undefined, {} as Parameters<typeof tool.execute>[4])).rejects.toThrow('目标已改变')
  })

  test('Given 正常 Pi 项目记忆写入 When 完成一轮 Then 仅将项目文件纳入可恢复快照', async () => {
    const owner = { sessionId: 'session-id', workspaceId: 'sample-id', turnId: 'turn-id' }
    const recorder = new TurnChangeRecorder(join(root, 'snapshots'))
    const run = new TurnChangesRun({ owner, root: project, toolCwd: project, recorder, isCurrent: () => true })
    await run.advance(owner.turnId)
    const [, write] = buildPiMemoryTools({
      service, workspaceId: owner.workspaceId, getAccess: () => access, isCurrent: () => true,
      beforeProjectFileWrite: (path, signal) => run.captureBeforeWrite(path, signal),
    })
    if (!write) throw new Error('前台记忆工具未注册')
    const execute = (input: Record<string, unknown>) => write.execute('id', input, undefined, undefined, {} as Parameters<typeof write.execute>[4])
    await execute({ scope: 'project', action: 'update', expectedRevision: null, content: '本轮项目记忆' })
    await execute({ scope: 'global', action: 'update', expectedRevision: null, content: '仅保存在画像中' })
    await run.finish()
    const [record] = await recorder.store.list(owner)
    expect(record).toMatchObject({ completion: 'completed', partial: false, files: [
      { path: 'MEMORY.md', kind: 'added', source: 'controlled-tool', before: { availability: 'missing' }, after: { availability: 'available' } },
    ] })
    expect(await recorder.store.readText(owner, record!.recordId, 'MEMORY.md', 'after')).toBe('本轮项目记忆')
  })

  test('Given 不可信 IPC 参数 When 更新和预览 Then 缺失 revision 或伪造目标被拒绝', () => {
    expect(() => parseAgentMemoryRequest({ action: 'update', target, content: '草稿' })).toThrow('revision')
    expect(() => parseAgentMemoryRequest({ action: 'target', scope: { kind: 'path', path: project } })).toThrow('记忆范围')
    const input = parseAgentMemoryRequest({ action: 'inspect', target: { ...target, id: '0'.repeat(64) } })
    if (input.action !== 'inspect') throw new Error('无效夹具')
    expect(() => executeMemoryAction(service, input.target, input, access)).toThrow('目标已改变')
    const migration = previewMemoryMigration(service, target)
    expect(() => applyMemoryMigration(service, target, { ...access, readOnly: true }, migration.id)).toThrow('没有记忆写入权限')
  })
})
