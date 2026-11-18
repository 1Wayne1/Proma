import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { AgentMemoryService, GLOBAL_MEMORY_LIMIT } from './agent-memory'
import type { MemoryTarget, MemoryWriteAccess, MemoryWriteResult } from './agent-memory'
import { writeJsonFileAtomic, writeTextFileAtomic } from './safe-file'

const writeAccess: MemoryWriteAccess = { source: 'user', permissionMode: 'bypassPermissions' }

function savedRevision(result: MemoryWriteResult): string {
  if (result.status !== 'saved' || result.document.revision === null) {
    throw new Error(`预期记忆已保存，实际为 ${result.status}`)
  }
  return result.document.revision
}

describe('本地记忆服务', () => {
  let temporary: string
  let config: string
  let projectA: string
  let projectB: string
  let service: AgentMemoryService
  let global: MemoryTarget
  let a: MemoryTarget
  let b: MemoryTarget

  function writeWorkspaceIndex(projectRootPath = projectA): void {
    const alias = process.platform === 'win32'
      ? projectA.toUpperCase().replace(/\\/g, '/')
      : `${projectA}${sep}.${sep}`
    writeJsonFileAtomic(join(config, 'agent-workspaces.json'), {
      version: 1,
      workspaces: [
        { id: 'a', slug: 'a', projectRootPath },
        { id: 'alias-a', slug: 'alias-a', projectRootPath: alias },
        { id: 'b', slug: 'b', projectRootPath: projectB },
        { id: 'managed', slug: 'managed' },
        { id: 'unsafe', slug: '../project-b' },
      ],
    }, true)
  }

  function findHistoryFile(target: MemoryTarget, revision: string): string {
    const directory = join(config, 'agent-memory', 'history', target.id)
    for (const key of readdirSync(directory)) {
      const path = join(directory, key, `${revision}.json`)
      if (existsSync(path)) return path
    }
    throw new Error('未找到历史夹具')
  }

  beforeEach(() => {
    temporary = mkdtempSync(join(realpathSync(tmpdir()), 'proma-memory-'))
    config = join(temporary, 'config')
    projectA = join(temporary, 'project-a')
    projectB = join(temporary, 'project-b')
    for (const directory of [config, projectA, projectB]) mkdirSync(directory)
    writeWorkspaceIndex()
    service = new AgentMemoryService(config)
    global = service.resolveTarget({ kind: 'global' })
    a = service.resolveTarget({ kind: 'project', workspaceId: 'a' })
    b = service.resolveTarget({ kind: 'project', workspaceId: 'b' })
  })

  afterEach(() => rmSync(temporary, { recursive: true, force: true }))

  test('Given 旧工作区和空记忆 When 查询 Then 不创建目录、不恢复索引、不触发旧记忆迁移', () => {
    const managedRoot = join(config, 'agent-workspaces', 'managed')
    const legacy = join(managedRoot, '.claude', 'memory')
    mkdirSync(legacy, { recursive: true })
    writeTextFileAtomic(join(legacy, 'MEMORY.md'), '仍保留在旧目录')
    const managed = service.resolveTarget({ kind: 'project', workspaceId: 'managed' })

    expect(service.inspect(managed)).toMatchObject({ content: null, revision: null })
    expect(service.inspect(a)).toMatchObject({ content: null, revision: null })
    expect(service.inspect(global)).toMatchObject({ content: null, revision: null, usage: { used: 0, limit: GLOBAL_MEMORY_LIMIT } })
    expect(service.history(managed)).toEqual([])
    expect(readdirSync(projectA)).toEqual([])
    expect(readdirSync(managedRoot)).toEqual(['.claude'])
    expect(readFileSync(join(legacy, 'MEMORY.md'), 'utf8')).toBe('仍保留在旧目录')
    const index = join(config, 'agent-workspaces.json')
    expect(JSON.parse(readFileSync(index, 'utf8')).version).toBe(1)
    expect(existsSync(join(config, 'agent-memory'))).toBe(false)
    renameSync(index, index + '.tmp')
    expect(() => service.inspect(a)).toThrow('失去授权')
    expect(existsSync(index)).toBe(false)
    expect(existsSync(index + '.tmp')).toBe(true)
  })

  test('Given 空画像 When 显式初始化两次 Then 空正文与不存在有不同 revision 并保留 UI 资料', () => {
    const profileJson = join(config, 'user-profile.json')
    writeJsonFileAtomic(profileJson, { userName: 'UI 昵称' })
    const empty = savedRevision(service.initialize(global, writeAccess))

    expect(service.inspect(global)).toMatchObject({ content: '', revision: empty, usage: { used: 0, limit: 5000 } })
    expect(service.initialize(global, writeAccess)).toMatchObject({ status: 'unchanged' })
    expect(service.update(global, writeAccess, null, '应冲突')).toEqual({ status: 'conflict', currentRevision: empty })
    expect(readFileSync(join(config, 'user_profile.md'), 'utf8')).toBe('')
    expect(JSON.parse(readFileSync(profileJson, 'utf8'))).toEqual({ userName: 'UI 昵称' })
  })

  test('Given 两个项目和同根别名 When 写入 Then 仅同一项目共享正文与历史', () => {
    const alias = service.resolveTarget({ kind: 'project', workspaceId: 'alias-a' })
    expect(alias.id).toBe(a.id)
    expect(a.id).not.toBe(b.id)
    const previous = savedRevision(service.update(a, writeAccess, null, '项目 A 原文'))
    savedRevision(service.update(alias, writeAccess, previous, '项目 A 新版'))
    savedRevision(service.update(b, writeAccess, null, '项目 B'))
    savedRevision(service.update(global, writeAccess, null, '共同画像'))

    expect(service.inspect(a).content).toBe('项目 A 新版')
    expect(service.history(alias)).toMatchObject([{ revision: previous }])
    expect(service.inspect(b).content).toBe('项目 B')
    expect(service.history(b)).toEqual([])
    expect(service.inspect(global).content).toBe('共同画像')
  })

  test('Given 受管工作区已有记忆 When 写入 Then 复用既有目录且保留指令正文', () => {
    const managedRoot = join(config, 'agent-workspaces', 'managed')
    const memory = join(managedRoot, 'memory')
    mkdirSync(memory, { recursive: true })
    writeTextFileAtomic(join(memory, 'MEMORY.md'), '旧索引')
    writeTextFileAtomic(join(managedRoot, 'AGENTS.md'), '用户规则')
    const managed = service.resolveTarget({ kind: 'project', workspaceId: 'managed' })

    const previous = service.inspect(managed)
    expect(previous.content).toBe('旧索引')
    savedRevision(service.update(managed, writeAccess, previous.revision, '新索引'))
    savedRevision(service.update(managed, writeAccess, null, '说明', 'memory\\笔记.md'))

    expect(readFileSync(join(memory, 'MEMORY.md'), 'utf8')).toBe('新索引')
    expect(readFileSync(join(memory, '笔记.md'), 'utf8')).toBe('说明')
    expect(readFileSync(join(managedRoot, 'AGENTS.md'), 'utf8')).toBe('用户规则')
    expect(existsSync(join(managedRoot, 'MEMORY.md'))).toBe(false)
    expect(() => service.inspect(managed, 'memory/MEMORY.md')).toThrow()
  })

  test('Given 相同 revision 的两个编辑者 When 并发保存 Then 只接受第一个且保留新内容', async () => {
    const first = savedRevision(service.update(a, writeAccess, null, '初始版本'))
    const [accepted, rejected] = await Promise.all([
      Promise.resolve().then(() => service.update(a, writeAccess, first, '编辑甲')),
      Promise.resolve().then(() => new AgentMemoryService(config).update(a, writeAccess, first, '编辑乙')),
    ])

    expect(rejected).toEqual({ status: 'conflict', currentRevision: savedRevision(accepted) })
    expect(service.inspect(a).content).toBe('编辑甲')
    expect(service.history(a)).toMatchObject([{ revision: first }])
  })

  test('Given 摘要含代理对 When 超过 UTF-16 预算 Then 拒绝保存并给出准确用量', () => {
    const limit = '🧠'.repeat(2500)
    const current = savedRevision(service.update(global, writeAccess, null, limit))

    expect(service.inspect(global).usage).toEqual({ used: 5000, limit: 5000 })
    expect(service.update(global, writeAccess, current, limit + 'x')).toEqual({
      status: 'over-budget', usage: { used: 5001, limit: 5000 },
    })
    expect(service.inspect(global).content).toBe(limit)
    expect(service.history(global)).toEqual([])
  })

  test('Given 持久化历史 When 服务重启并恢复旧 revision Then 逐字节保留 BOM、CRLF 和原正文', () => {
    const original = '\uFEFF原始正文\r\n'
    const old = savedRevision(service.update(a, writeAccess, null, original))
    const current = savedRevision(service.update(a, writeAccess, old, '改后正文'))
    const restarted = new AgentMemoryService(config)

    expect(restarted.history(a)).toMatchObject([{ revision: old }])
    expect(restarted.restore(a, writeAccess, old, old)).toEqual({ status: 'conflict', currentRevision: current })
    expect(savedRevision(restarted.restore(a, writeAccess, current, old))).toBe(old)
    expect(readFileSync(join(projectA, 'MEMORY.md'))).toEqual(Buffer.from(original))
    expect(restarted.history(a)).toMatchObject([{ revision: current }])
    expect(() => restarted.restore(b, writeAccess, null, old)).toThrow('不存在')
  })

  test('Given 外部编辑 When 用旧 revision 恢复或更新 Then 文件和历史都不被覆盖', () => {
    const old = savedRevision(service.update(a, writeAccess, null, '旧'))
    const current = savedRevision(service.update(a, writeAccess, old, '当时最新'))
    writeTextFileAtomic(join(projectA, 'MEMORY.md'), '外部编辑')
    const external = service.inspect(a).revision

    expect(service.restore(a, writeAccess, current, old)).toEqual({ status: 'conflict', currentRevision: external })
    expect(service.update(a, writeAccess, current, '旧编辑器')).toEqual({ status: 'conflict', currentRevision: external })
    expect(service.inspect(a).content).toBe('外部编辑')
    expect(service.history(a)).toMatchObject([{ revision: old }])
  })

  test('Given 两份笔记 When 一份被外部删除 Then 只能从对应笔记的历史恢复', () => {
    const note = 'memory/测试笔记.md'
    const other = 'memory/其他笔记.md'
    const old = savedRevision(service.update(a, writeAccess, null, '笔记旧文', note))
    savedRevision(service.update(a, writeAccess, old, '笔记新文', note))
    const otherRevision = savedRevision(service.update(a, writeAccess, null, '独立笔记', other))
    rmSync(join(projectA, note))

    expect(service.inspect(a, note).revision).toBeNull()
    expect(service.history(a, note)).toMatchObject([{ revision: old }])
    expect(() => service.restore(a, writeAccess, otherRevision, old, other)).toThrow('不存在')
    expect(savedRevision(service.restore(a, writeAccess, null, old, note))).toBe(old)
    expect(service.inspect(a, note).content).toBe('笔记旧文')
    expect(service.inspect(a, other).revision).toBe(otherRevision)
  })

  test('Given 历史 JSON 损坏 When 列出或恢复 Then 报错并保留当前正文', () => {
    const old = savedRevision(service.update(a, writeAccess, null, '旧'))
    const current = savedRevision(service.update(a, writeAccess, old, '当前'))
    writeTextFileAtomic(findHistoryFile(a, old), '{}')

    expect(() => service.history(a)).toThrow('历史已损坏')
    expect(() => service.restore(a, writeAccess, current, old)).toThrow('历史已损坏')
    expect(service.inspect(a)).toMatchObject({ content: '当前', revision: current })
  })

  test('Given 项目被原路径替换或重新关联 When 使用旧目标 Then 不能读取或覆盖新目录', () => {
    const old = savedRevision(service.update(a, writeAccess, null, '原项目'))
    const displaced = join(temporary, 'displaced')
    renameSync(projectA, displaced)
    mkdirSync(projectA)
    writeTextFileAtomic(join(projectA, 'MEMORY.md'), '原项目')

    expect(() => service.inspect(a)).toThrow('记忆目标已改变')
    expect(() => service.update(a, writeAccess, old, '应拒绝')).toThrow('记忆目标已改变')
    expect(readFileSync(join(projectA, 'MEMORY.md'), 'utf8')).toBe('原项目')
    expect(readFileSync(join(displaced, 'MEMORY.md'), 'utf8')).toBe('原项目')
    const replacement = service.resolveTarget({ kind: 'project', workspaceId: 'a' })
    writeWorkspaceIndex(projectB)
    expect(() => service.inspect(replacement)).toThrow('记忆目标已改变')
    expect(service.resolveTarget({ kind: 'project', workspaceId: 'a' }).id).toBe(b.id)
  })

  test('Given 目录链接、越界路径和未授权工作区 When 查询或写入 Then 不访问目标内容', () => {
    const linkedDirectory = join(projectA, 'memory')
    symlinkSync(projectB, linkedDirectory, process.platform === 'win32' ? 'junction' : 'dir')
    writeTextFileAtomic(join(projectB, '笔记.md'), '不能读写的内容')

    expect(() => service.inspect(a, 'memory/笔记.md')).toThrow()
    expect(() => service.update(a, writeAccess, null, '不能写入', 'memory/笔记.md')).toThrow()
    expect(() => service.inspect(a, 'memory/../AGENTS.md')).toThrow()
    expect(() => service.inspect(a, join(projectB, '笔记.md'))).toThrow()
    expect(() => service.resolveTarget({ kind: 'project', workspaceId: 'missing' })).toThrow('失去授权')
    expect(() => service.resolveTarget({ kind: 'project', workspaceId: 'unsafe' })).toThrow('无效的受管记忆工作区')
    const oldRoot = join(temporary, 'displaced')
    renameSync(projectA, oldRoot)
    symlinkSync(projectB, projectA, process.platform === 'win32' ? 'junction' : 'dir')
    expect(() => service.resolveTarget({ kind: 'project', workspaceId: 'a' })).toThrow('符号链接')
    expect(readFileSync(join(projectB, '笔记.md'), 'utf8')).toBe('不能读写的内容')
  })

  test('Given 只读、计划、自动化、委派和外部上下文 When 请求变更 Then 拒绝且不创建历史', () => {
    const current = savedRevision(service.update(a, writeAccess, null, '授权用户保存'))
    const forbidden: MemoryWriteAccess[] = [
      { ...writeAccess, readOnly: true },
      { ...writeAccess, permissionMode: 'plan' },
      { ...writeAccess, source: 'automation' },
      { ...writeAccess, source: 'delegation' },
      { ...writeAccess, source: 'external' },
    ]
    for (const access of forbidden) {
      expect(() => service.initialize(global, access)).toThrow('没有记忆写入权限')
      expect(() => service.update(a, access, current, '越权变更')).toThrow('没有记忆写入权限')
      expect(() => service.restore(a, access, current, current)).toThrow('没有记忆写入权限')
    }
    expect(service.inspect(a).content).toBe('授权用户保存')
    expect(service.inspect(global).revision).toBeNull()
    expect(existsSync(join(config, 'agent-memory'))).toBe(false)
  })

  test('Given 私有历史目录无法创建 When 更新正文 Then 旧 revision 保持不变', () => {
    const revision = savedRevision(service.update(a, writeAccess, null, '原正文'))
    writeTextFileAtomic(join(config, 'agent-memory'), '阻挡历史目录创建')

    expect(() => service.update(a, writeAccess, revision, '新正文')).toThrow()
    expect(service.inspect(a)).toMatchObject({ content: '原正文', revision })
    expect(readFileSync(join(config, 'agent-memory'), 'utf8')).toBe('阻挡历史目录创建')
  })

  test.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'Given 历史已保存但正文原子写失败 When 重试 Then 原文保留且历史只显示已替换版本',
    () => {
      const previous = savedRevision(service.update(a, writeAccess, null, '原正文'))
      chmodSync(projectA, 0o500)
      try {
        expect(() => service.update(a, writeAccess, previous, '新正文')).toThrow()
        expect(service.inspect(a)).toMatchObject({ content: '原正文', revision: previous })
        expect(service.history(a)).toEqual([])
      } finally {
        chmodSync(projectA, 0o700)
      }
      savedRevision(service.update(a, writeAccess, previous, '新正文'))
      expect(service.history(a)).toMatchObject([{ revision: previous }])
      expect(readdirSync(projectA)).toEqual(['MEMORY.md'])
    },
  )
})
