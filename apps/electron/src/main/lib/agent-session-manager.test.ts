import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import * as os from 'node:os'
import { join } from 'node:path'

type AgentSessionManager = typeof import('./agent-session-manager')
type AgentSessionContextPrompt = typeof import('./agent-session-context-prompt')

let manager: AgentSessionManager
let contextPrompt: AgentSessionContextPrompt
let tempHome: string
const originalHome = process.env.HOME
const originalPromaDev = process.env.PROMA_DEV

// agent-session-manager loads Pi lazily for fork/rewind, so this focused fake isolates
// entry-tree semantics without requiring a real Pi session JSONL fixture.
mock.module('@earendil-works/pi-coding-agent', () => ({
  SessionManager: {
    open: (sessionFile: string) => ({
      createBranchedSession: (entryId: string) => {
        const branchFile = join(tempHome, `.pi-branch-${entryId}.jsonl`)
        writeFileSync(branchFile, '', 'utf-8')
        return branchFile
      },
      getSessionFile: () => sessionFile,
      getSessionId: () => 'pi-test-session',
      getEntry: (entryId: string) => entryId === 'entry-keep' ? { id: entryId } : undefined,
    }),
    forkFrom: (_branchFile: string) => {
      const forkFile = join(tempHome, '.pi-fork.jsonl')
      writeFileSync(forkFile, '', 'utf-8')
      return {
        getSessionFile: () => forkFile,
        getSessionId: () => 'pi-fork-session',
        getEntry: (entryId: string) => entryId === 'entry-keep' ? { id: entryId } : undefined,
      }
    },
  },
}))

mock.module('electron', () => ({
  app: {
    isPackaged: true,
    getPath: () => join(process.env.HOME ?? tempHome, 'Library', 'Application Support'),
  },
  BrowserWindow: class {},
  clipboard: {},
  dialog: {},
  nativeImage: { createFromPath: () => ({}) },
  nativeTheme: {},
  powerMonitor: {},
  powerSaveBlocker: {},
  screen: {},
  shell: {},
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString('utf-8'),
  },
}))

mock.module('node:os', () => ({
  ...os,
  homedir: () => tempHome,
}))

function jsonl(rows: string[]): string {
  return rows.join('\n') + '\n'
}

function writeAgentSessionJsonl(sessionId: string, rows: string[]): void {
  const dir = join(tempHome, '.proma', 'agent-sessions')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${sessionId}.jsonl`), jsonl(rows), 'utf-8')
}

function writeAgentSessionsIndex(sessions: Array<{
  id: string
  title: string
  workspaceId: string
  createdAt: number
  updatedAt: number
  agentRuntime?: string
  sdkSessionId?: string
  piSessionFile?: string
  piEntryBindings?: Record<string, string>
  forkSourceSdkSessionId?: string
  resumeAtMessageUuid?: string
}>): void {
  const dir = join(tempHome, '.proma')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'agent-sessions.json'), JSON.stringify({ version: 1, sessions }), 'utf-8')
}

function writeAgentWorkspacesIndex(workspaces: Array<{
  id: string
  name: string
  slug: string
  createdAt: number
  updatedAt: number
}>): void {
  const dir = join(tempHome, '.proma')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'agent-workspaces.json'), JSON.stringify({ version: 2, workspaces }), 'utf-8')
}

function createIndexedSessions(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    id: `session-${index}`,
    title: `会话 ${index}`,
    workspaceId: 'workspace-a',
    createdAt: index,
    updatedAt: index,
  }))
}

beforeAll(async () => {
  tempHome = mkdtempSync(join(os.tmpdir(), 'proma-agent-session-manager-'))
  process.env.HOME = tempHome
  process.env.PROMA_DEV = '0'
  manager = await import('./agent-session-manager')
  contextPrompt = await import('./agent-session-context-prompt')
})

afterAll(() => {
  if (originalHome === undefined) {
    delete process.env.HOME
  } else {
    process.env.HOME = originalHome
  }
  if (originalPromaDev === undefined) {
    delete process.env.PROMA_DEV
  } else {
    process.env.PROMA_DEV = originalPromaDev
  }
  rmSync(tempHome, { recursive: true, force: true })
})

describe('Agent 会话 JSONL 读取', () => {
  test('Given 会话 JSONL 混入损坏行 When 读取 SDKMessage Then 跳过坏行并保留其它消息', () => {
    writeAgentSessionJsonl('session-with-bad-line', [
      JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: '你好' }] }, parent_tool_use_id: null }),
      '{ 这不是合法 JSON',
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: '仍然可读' }] }, parent_tool_use_id: null }),
    ])

    const messages = manager.getAgentSessionSDKMessages('session-with-bad-line')

    expect(messages.map((message) => message.type)).toEqual(['user', 'assistant'])
  })

  test('Given 会话 JSONL 存在损坏行 When 截断 SDKMessage Then 抛错避免重写不完整历史', () => {
    writeAgentSessionJsonl('session-truncate-bad-line', [
      JSON.stringify({ type: 'assistant', uuid: 'assistant-1', message: { content: [{ type: 'text', text: '完成' }] } }),
      '{ 这不是合法 JSON',
    ])

    expect(() => manager.truncateSDKMessages('session-truncate-bad-line', 'assistant-1'))
      .toThrow('JSONL 第 2 行解析失败')
  })
})

describe('Agent 会话 runtime 元数据', () => {
  test('Given v2 保留了布尔速度的 Pi 会话 When 迁移 Then 速度可恢复且不会误标为 Claude 历史', () => {
    const path = join(tempHome, '.proma', 'agent-sessions.json')
    const entries = createIndexedSessions(3)
    writeFileSync(path, JSON.stringify({
      version: 2,
      sessions: [
        { ...entries[0], codexFastMode: true },
        { ...entries[1], codexFastMode: false },
        { ...entries[2], codexFastMode: true, codexSpeed: 'ultrafast', narrationMode: 'explain', archived: true },
      ],
    }))
    const migrated = manager.getAgentSessionMeta('session-0')
    expect(migrated).toMatchObject({ codexSpeed: 'fast', codexFastMode: true })
    expect(migrated?.legacyTranscript).toBeUndefined()
    expect(manager.getAgentSessionMeta('session-1')).toMatchObject({ codexSpeed: 'standard', codexFastMode: false })
    expect(manager.getAgentSessionMeta('session-2')).toMatchObject({ codexSpeed: 'ultrafast', narrationMode: 'explain', archived: true })
    const persisted = readFileSync(path, 'utf8')
    expect(JSON.parse(persisted).version).toBe(3)
    expect(manager.getAgentSessionMeta('session-0')?.codexSpeed).toBe('fast')
    expect(readFileSync(path, 'utf8')).toBe(persisted)
  })

  test('Given 两个项目 When 归档、重读和恢复 Then 会话原有归档状态与项目归属保持', async () => {
    const workspace = await import('./agent-workspace-manager')
    writeAgentWorkspacesIndex([
      { id: 'workspace-a', slug: 'workspace-a', name: '甲', createdAt: 1, updatedAt: 1 },
      { id: 'workspace-b', slug: 'workspace-b', name: '乙', createdAt: 2, updatedAt: 2 },
    ])
    writeAgentSessionsIndex([{ ...createIndexedSessions(1)[0]!, agentRuntime: 'pi' }])
    expect(workspace.setWorkspaceArchived('workspace-a', true).archived).toBe(true)
    expect(workspace.listAgentWorkspaces().find(item => item.id === 'workspace-a')?.archived).toBe(true)
    expect(() => workspace.setWorkspaceArchived('workspace-b', true)).toThrow('活跃项目')
    expect(manager.getAgentSessionMeta('session-0')?.workspaceId).toBe('workspace-a')
    expect(manager.getAgentSessionMeta('session-0')?.archived).toBeUndefined()
    expect(workspace.setWorkspaceArchived('workspace-a', false).archived).toBe(false)
  })

  test('Given 本地 Skill 激活、失败的读取及跨项目同名记录 When 统计 Then 按实际使用会话去重并保持隔离', async () => {
    const { getWorkspaceSkillUsage } = await import('./skill-usage-service')
    const workspace = { id: 'usage', slug: 'usage', name: 'Usage', createdAt: 1, updatedAt: 1 }
    writeAgentWorkspacesIndex([workspace])
    writeAgentSessionsIndex(createIndexedSessions(2).map((session, index) => ({
      ...session,
      workspaceId: index === 0 ? workspace.id : 'other',
      agentRuntime: 'pi',
    })))
    const activation = (workspaceSlug: string, slug: string) => ({
      slug, name: slug, workspaceSlug, workspaceSkillPath: `${slug}/SKILL.md`, sources: ['explicit'],
    })
    const messages = [
      { type: 'user', skill_activations: [activation('other', 'example'), activation(workspace.slug, 'example')] },
      { type: 'user', skill_activations: [activation(workspace.slug, 'example')] },
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', id: 'failed', input: { file_path: join(tempHome, '.proma', 'agent-workspaces', 'usage', 'skills', 'failed', 'SKILL.md') } }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'failed', is_error: true }] } },
    ]
    writeAgentSessionJsonl('session-0', messages.map(message => JSON.stringify(message)))
    writeAgentSessionJsonl('session-1', [JSON.stringify({ type: 'user', skill_activations: [activation(workspace.slug, 'out-of-scope')] })])
    expect(await getWorkspaceSkillUsage(workspace)).toEqual({ sessionsBySlug: { example: 1 }, partial: false })
  })

  test('Given 已下线渠道 When 迁移并消费通知 Then 只返回非敏感摘要且重读不会重复提示', async () => {
    const { getChannelsPath } = await import('./config-paths')
    const { listChannels, consumeChannelRemovalNotices } = await import('./channel-manager')
    const path = getChannelsPath()
    writeFileSync(path, JSON.stringify({
      version: 7,
      channels: [
        { id: 'removed', name: '历史渠道', provider: 'opencode-go-openai', baseUrl: 'https://old.example', apiKey: 'fixture-key', models: [], enabled: true },
        { id: 'kept', name: '保留渠道', provider: 'deepseek', baseUrl: 'https://api.deepseek.com/v1', apiKey: 'fixture-key', models: [], enabled: true },
      ],
    }))
    try {
      expect(listChannels().map(channel => channel.id)).toEqual(['kept'])
      expect(consumeChannelRemovalNotices()).toEqual([{ id: 'removed', name: '历史渠道', reason: 'retired' }])
      expect(consumeChannelRemovalNotices()).toEqual([])
    } finally {
      rmSync(path, { force: true })
    }
  })

  test('Given 已保存 OpenAI medium 默认值 When 新建会话 Then 始终创建并持久化 Pi 会话', () => {
    const settingsPath = join(tempHome, '.proma', 'settings.json')
    mkdirSync(join(tempHome, '.proma'), { recursive: true })
    writeFileSync(settingsPath, JSON.stringify({
      agentThinking: { type: 'adaptive' },
      agentEffort: 'max',
      defaultOpenAIThinkingLevel: 'medium',
    }), 'utf-8')

    try {
      const session = manager.createAgentSession('默认内核会话')

      expect(session.reasoningLevel).toBe('medium')
      expect(manager.getAgentSessionMeta(session.id)?.reasoningLevel).toBe('medium')
    } finally {
      rmSync(settingsPath, { force: true })
    }
  })

  test('Given 历史 Claude 会话 When 读取并尝试分叉或回退 Then 迁移为只读 transcript 并拒绝续接', async () => {
    writeAgentSessionsIndex([{
      id: 'legacy-claude-session',
      title: '历史 Claude 会话',
      workspaceId: 'workspace-a',
      createdAt: 1,
      updatedAt: 1,
      agentRuntime: 'claude',
      sdkSessionId: 'claude-artifact',
      piSessionFile: '/tmp/not-a-pi-session.jsonl',
      piEntryBindings: { 'assistant-1': 'entry-1' },
      forkSourceSdkSessionId: 'claude-source',
      resumeAtMessageUuid: 'assistant-1',
    }, {
      id: 'legacy-implicit-session',
      title: '缺少 runtime 的历史会话',
      workspaceId: 'workspace-a',
      createdAt: 2,
      updatedAt: 2,
    }])

    const migrated = manager.getAgentSessionMeta('legacy-claude-session')
    const implicitlyMigrated = manager.getAgentSessionMeta('legacy-implicit-session')

    expect(migrated).toMatchObject({
      legacyTranscript: { sourceRuntime: 'claude', continuationRequired: true },
    })
    expect(migrated?.sdkSessionId).toBeUndefined()
    expect(migrated?.piSessionFile).toBeUndefined()
    expect(migrated?.piEntryBindings).toBeUndefined()
    expect(implicitlyMigrated?.legacyTranscript).toEqual({ sourceRuntime: 'claude', continuationRequired: true })
    await expect(manager.forkAgentSession({ sessionId: 'legacy-claude-session', upToMessageUuid: 'assistant-1' }))
      .rejects.toThrow('历史 Claude transcript 为只读')
    await expect(manager.rewindPiAgentSession('legacy-claude-session', 'assistant-1'))
      .rejects.toThrow('历史 Claude transcript 为只读')
  })

  test('Given Pi session moved to another workspace When metadata is persisted Then clears the cwd-bound artifact and bindings', () => {
    writeAgentWorkspacesIndex([
      { id: 'workspace-a', name: '工作区 A', slug: 'workspace-a', createdAt: 1, updatedAt: 1 },
      { id: 'workspace-b', name: '工作区 B', slug: 'workspace-b', createdAt: 1, updatedAt: 1 },
    ])
    writeAgentSessionsIndex([{
      id: 'pi-session-to-move',
      title: 'Pi 会话',
      workspaceId: 'workspace-a',
      createdAt: 1,
      updatedAt: 1,
      agentRuntime: 'pi',
      sdkSessionId: 'pi-session-id',
      piSessionFile: '/tmp/pi-session.jsonl',
      piEntryBindings: { 'assistant-1': 'entry-1' },
    }])
    mkdirSync(join(tempHome, '.proma', 'agent-workspaces', 'workspace-a', 'pi-session-to-move'), { recursive: true })

    const moved = manager.moveSessionToWorkspace('pi-session-to-move', 'workspace-b')

    expect(moved.workspaceId).toBe('workspace-b')
    expect(moved.sdkSessionId).toBeUndefined()
    expect(moved.piSessionFile).toBeUndefined()
    expect(moved.piEntryBindings).toBeUndefined()
    expect(existsSync(join(tempHome, '.proma', 'agent-workspaces', 'workspace-b', 'pi-session-to-move'))).toBe(true)
  })

  test('Given 新安装用户保存关闭思考 When 连续新建会话 Then 不被旧版迁移改回 high', () => {
    const settingsPath = join(tempHome, '.proma', 'settings.json')
    const indexPath = join(tempHome, '.proma', 'agent-sessions.json')
    const indexBackupPath = `${indexPath}.bak`
    mkdirSync(join(tempHome, '.proma'), { recursive: true })
    rmSync(indexPath, { force: true })
    rmSync(indexBackupPath, { force: true })
    writeFileSync(settingsPath, JSON.stringify({
      agentThinking: { type: 'adaptive' },
      agentEffort: 'medium',
      defaultOpenAIThinkingLevel: 'off',
    }), 'utf-8')

    try {
      const firstSession = manager.createAgentSession('关闭思考会话一')
      const secondSession = manager.createAgentSession('关闭思考会话二')

      expect(manager.getAgentSessionMeta(firstSession.id)?.reasoningLevel).toBe('off')
      expect(manager.getAgentSessionMeta(secondSession.id)?.reasoningLevel).toBe('off')
    } finally {
      rmSync(settingsPath, { force: true })
      rmSync(indexPath, { force: true })
      rmSync(indexBackupPath, { force: true })
    }
  })

  test('Given session settings When updating Then persists reasoning depth per session', () => {
    const session = manager.createAgentSession('Codex 会话')

    const updated = manager.updateAgentSessionMeta(session.id, { reasoningLevel: 'xhigh' })

    expect(updated.reasoningLevel).toBe('xhigh')
    expect(manager.getAgentSessionMeta(session.id)).toMatchObject({ reasoningLevel: 'xhigh' })
  })

  test('Given a session When star state is updated Then it persists without changing freshness or archive state', () => {
    const session = manager.createAgentSession('星标会话')
    const archived = manager.updateAgentSessionMeta(session.id, { archived: true })

    const updated = manager.updateAgentSessionMeta(session.id, { starred: true })

    expect(updated).toMatchObject({ starred: true, archived: true })
    expect(updated.updatedAt).toBe(archived.updatedAt)
    expect(manager.getAgentSessionMeta(session.id)).toMatchObject({ starred: true, archived: true })
  })
})

describe('Agent 会话正文搜索', () => {
  test('Given 用户/助手正文和内部块 When 搜索 Then 只返回最多两个不同正文消息命中', async () => {
    writeAgentSessionsIndex([{
      id: 'search-content-session',
      title: '正文搜索测试',
      workspaceId: 'workspace-a',
      createdAt: 1,
      updatedAt: 1,
    }])
    writeAgentSessionJsonl('search-content-session', [
      JSON.stringify({
        type: 'assistant',
        uuid: 'assistant-internal',
        message: {
          content: [
            { type: 'thinking', thinking: '命中词隐藏思考' },
            { type: 'tool_use', name: 'Read', input: { query: '命中词工具参数' } },
          ],
        },
      }),
      JSON.stringify({
        type: 'user',
        uuid: 'user-1',
        message: { content: [{ type: 'text', text: '用户正文命中词' }] },
      }),
      JSON.stringify({
        type: 'assistant',
        uuid: 'assistant-1',
        message: { content: [{ type: 'text', text: '助手正文命中词' }] },
      }),
      JSON.stringify({
        type: 'user',
        uuid: 'tool-result-user',
        message: { content: [{ type: 'tool_result', content: '命中词工具结果' }] },
      }),
    ])

    const results = await manager.searchAgentSessionMessages('命中词')

    expect(results).toHaveLength(2)
    expect(results.map((result) => result.messageId)).toEqual(['user-1', 'assistant-1'])
    expect(results.every((result) => result.role === 'user' || result.role === 'assistant')).toBe(true)
  })

  test('Given 单会话中有多个不同质量的命中 When 搜索 Then 只保留两条最佳结果并让 user 同分优先', async () => {
    writeAgentSessionsIndex([{
      id: 'ranked-search-session',
      title: '排序搜索测试',
      workspaceId: 'workspace-a',
      createdAt: 1,
      updatedAt: 1,
    }])
    writeAgentSessionJsonl('ranked-search-session', [
      JSON.stringify({ type: 'assistant', uuid: 'fuzzy', message: { content: [{ type: 'text', text: '搜索优方案' }] } }),
      JSON.stringify({ type: 'assistant', uuid: 'fragment', message: { content: [{ type: 'text', text: '搜索优化内容' }] } }),
      JSON.stringify({ type: 'assistant', uuid: 'assistant-exact', message: { content: [{ type: 'text', text: '搜索优化方案' }] } }),
      JSON.stringify({ type: 'user', uuid: 'user-exact', message: { content: [{ type: 'text', text: '搜索优化方案' }] } }),
    ])

    const results = await manager.searchAgentSessionMessages('搜索优化方案')

    expect(results.map((result) => result.messageId)).toEqual(['user-exact', 'assistant-exact'])
    expect(results.map((result) => result.role)).toEqual(['user', 'assistant'])
  })

  test('Given 重复的 Agent SDK snapshot When 搜索 Then 每个 messageId 只返回最佳命中一次', async () => {
    writeAgentSessionsIndex([{
      id: 'deduplicated-search-session',
      title: '去重搜索测试',
      workspaceId: 'workspace-a',
      createdAt: 1,
      updatedAt: 1,
    }])
    writeAgentSessionJsonl('deduplicated-search-session', [
      JSON.stringify({ type: 'assistant', uuid: 'duplicate', message: { content: [{ type: 'text', text: '搜索优方案' }] } }),
      JSON.stringify({ type: 'assistant', uuid: 'duplicate', message: { content: [{ type: 'text', text: '搜索优化方案' }] } }),
      JSON.stringify({ type: 'user', uuid: 'user-exact', message: { content: [{ type: 'text', text: '搜索优化方案' }] } }),
    ])

    const results = await manager.searchAgentSessionMessages('搜索优化方案')

    expect(results.map((result) => result.messageId)).toEqual(['user-exact', 'duplicate'])
    expect(results).toHaveLength(2)
  })

  test('Given 超过 100 个命中会话 When 搜索 Then 最多返回 100 个会话且每个最多两个命中', async () => {
    const sessions = createIndexedSessions(101)
    writeAgentSessionsIndex(sessions)
    for (const session of sessions) {
      writeAgentSessionJsonl(session.id, [
        JSON.stringify({ type: 'user', uuid: `${session.id}-1`, message: { content: [{ type: 'text', text: '命中词一' }] } }),
        JSON.stringify({ type: 'assistant', uuid: `${session.id}-2`, message: { content: [{ type: 'text', text: '命中词二' }] } }),
        JSON.stringify({ type: 'user', uuid: `${session.id}-3`, message: { content: [{ type: 'text', text: '命中词三' }] } }),
      ])
    }

    const results = await manager.searchAgentSessionMessages('命中词')
    const sessionIds = new Set(results.map((result) => result.sessionId))

    expect(sessionIds).toHaveLength(100)
    expect(results).toHaveLength(200)
    expect([...sessionIds][0]).toBe('session-100')
    expect(results.filter((result) => result.sessionId === 'session-100')).toHaveLength(2)
  })
})

describe('Agent 会话引用搜索', () => {
  test('Given 工作区有超过 20 个会话 When 请求最近 200 条 Then 按更新时间返回 200 条', async () => {
    writeAgentSessionsIndex(createIndexedSessions(220))

    const results = await manager.searchAgentSessionReferences({
      workspaceId: 'workspace-a',
      limit: 200,
    })

    expect(results).toHaveLength(200)
    expect(results[0]?.sessionId).toBe('session-219')
    expect(results.at(-1)?.sessionId).toBe('session-20')
    expect(results.every((result) => result.matchSource === 'recent')).toBe(true)
  })

  test('Given 请求数量超过性能上限 When 搜索可引用会话 Then 最多返回 200 条', async () => {
    writeAgentSessionsIndex(createIndexedSessions(220))

    const results = await manager.searchAgentSessionReferences({
      workspaceId: 'workspace-a',
      limit: 500,
    })

    expect(results).toHaveLength(200)
  })

  test('Given 未指定工作区 When 搜索可引用会话 Then 返回全部工作区的最近会话并标示来源', async () => {
    writeAgentWorkspacesIndex([
      { id: 'workspace-a', name: '产品研发', slug: 'product-dev', createdAt: 1, updatedAt: 1 },
      { id: 'workspace-b', name: '客户支持', slug: 'customer-support', createdAt: 2, updatedAt: 2 },
      { id: 'workspace-c', name: '当前项目', slug: 'current-project', createdAt: 3, updatedAt: 3 },
    ])
    writeAgentSessionsIndex([
      { id: 'workspace-a-session', title: '同名会话', workspaceId: 'workspace-a', createdAt: 1, updatedAt: 1 },
      { id: 'workspace-b-session', title: '同名会话', workspaceId: 'workspace-b', createdAt: 2, updatedAt: 2 },
      { id: 'current-session', title: '当前会话', workspaceId: 'workspace-c', createdAt: 3, updatedAt: 3 },
    ])

    const results = await manager.searchAgentSessionReferences({
      excludeSessionId: 'current-session',
      limit: 200,
    })

    expect(results).toMatchObject([
      { sessionId: 'workspace-b-session', workspaceName: '客户支持', workspaceSlug: 'customer-support' },
      { sessionId: 'workspace-a-session', workspaceName: '产品研发', workspaceSlug: 'product-dev' },
    ])
  })

  test('Given 消息内容命中 When 搜索可引用会话 Then 异步返回匹配片段和工作区来源', async () => {
    writeAgentWorkspacesIndex([
      { id: 'workspace-b', name: '客户支持', slug: 'customer-support', createdAt: 1, updatedAt: 1 },
    ])
    writeAgentSessionsIndex([
      { id: 'message-session', title: '项目讨论', workspaceId: 'workspace-b', createdAt: 1, updatedAt: 1 },
    ])
    writeAgentSessionJsonl('message-session', [
      JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: '需要核对跨工作区的会话引用。' }] } }),
    ])

    const results = await manager.searchAgentSessionReferences({ query: '跨工作区' })

    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({
      sessionId: 'message-session',
      workspaceName: '客户支持',
      workspaceSlug: 'customer-support',
      matchSource: 'message',
      snippet: expect.stringContaining('跨工作区'),
    })
  })

  test('Given 正文扫描预算耗尽 When 较旧会话标题命中 Then 仍返回标题命中结果', async () => {
    const scannedSessions = Array.from({ length: 50 }, (_, index) => ({
      id: `body-scan-${index}`,
      title: `普通会话 ${index}`,
      workspaceId: 'workspace-a',
      createdAt: 100 - index,
      updatedAt: 100 - index,
    }))
    writeAgentSessionsIndex([
      ...scannedSessions,
      { id: 'older-title-match', title: '目标会话', workspaceId: 'workspace-a', createdAt: 1, updatedAt: 1 },
    ])
    for (const session of scannedSessions) {
      writeAgentSessionJsonl(session.id, [
        JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: '没有匹配内容' }] } }),
      ])
    }

    const results = await manager.searchAgentSessionReferences({ query: '目标' })

    expect(results).toMatchObject([{ sessionId: 'older-title-match', matchSource: 'title' }])
  })

  test('Given 正文命中在单文件扫描上限之后 When 搜索引用 Then 不读取超出输入补全预算的历史', async () => {
    writeAgentSessionsIndex([
      { id: 'oversized-session', title: '大历史', workspaceId: 'workspace-a', createdAt: 1, updatedAt: 1 },
    ])
    writeAgentSessionJsonl('oversized-session', [
      JSON.stringify({
        type: 'user',
        message: { content: [{ type: 'text', text: `${'x'.repeat(300 * 1024)}隐藏关键词` }] },
      }),
    ])

    const results = await manager.searchAgentSessionReferences({ query: '隐藏关键词' })

    expect(results).toEqual([])
  })
})

describe('Pi entry binding recovery', () => {
  test('Given Pi branch excludes later entries When fork Then keeps only bindings in the fork artifact', async () => {
    const piSessionFile = join(tempHome, '.pi-source-fork.jsonl')
    writeFileSync(piSessionFile, '', 'utf-8')
    writeAgentSessionsIndex([{
      id: 'pi-fork-source', title: 'Pi source', workspaceId: 'workspace-a', createdAt: 1, updatedAt: 1,
      agentRuntime: 'pi', sdkSessionId: 'pi-source-session', piSessionFile,
      piEntryBindings: {
        'assistant-keep': 'entry-keep',
        'assistant-stale': 'entry-stale',
        'assistant-missing': 'missing-entry',
      },
    }])
    writeAgentSessionJsonl('pi-fork-source', [
      JSON.stringify({ type: 'user', uuid: 'user-1', message: { content: [{ type: 'text', text: '开始' }] } }),
      JSON.stringify({ type: 'assistant', uuid: 'assistant-keep', message: { content: [{ type: 'text', text: '保留' }] } }),
      JSON.stringify({ type: 'assistant', uuid: 'assistant-stale', message: { content: [{ type: 'text', text: '丢弃' }] } }),
    ])

    const forked = await manager.forkAgentSession({ sessionId: 'pi-fork-source', upToMessageUuid: 'assistant-keep' })

    expect(forked.piEntryBindings).toEqual({ 'assistant-keep': 'entry-keep' })
    expect(manager.getAgentSessionMeta(forked.id)?.piEntryBindings).toEqual({ 'assistant-keep': 'entry-keep' })
    expect(forked.piSessionFile && existsSync(forked.piSessionFile)).toBe(true)
  })

  test('Given rewind excludes transcript and artifact entries When rewinding Then keeps only valid retained assistant bindings', async () => {
    const piSessionFile = join(tempHome, '.pi-source-rewind.jsonl')
    writeFileSync(piSessionFile, '', 'utf-8')
    writeAgentSessionsIndex([{
      id: 'pi-rewind-source', title: 'Pi rewind', workspaceId: 'workspace-a', createdAt: 1, updatedAt: 1,
      agentRuntime: 'pi', sdkSessionId: 'pi-source-session', piSessionFile,
      piEntryBindings: {
        'assistant-keep': 'entry-keep',
        'assistant-stale': 'entry-stale',
        'assistant-alias': 'entry-keep',
        'assistant-broken': 'missing-entry',
      },
    }])
    writeAgentSessionJsonl('pi-rewind-source', [
      JSON.stringify({ type: 'user', uuid: 'user-1', message: { content: [{ type: 'text', text: '开始' }] } }),
      JSON.stringify({ type: 'assistant', uuid: 'assistant-keep', message: { content: [{ type: 'text', text: '保留' }] } }),
      JSON.stringify({ type: 'user', uuid: 'user-after', message: { content: [{ type: 'text', text: '后续' }] } }),
      JSON.stringify({ type: 'assistant', uuid: 'assistant-stale', message: { content: [{ type: 'text', text: '丢弃' }] } }),
    ])

    const retainedCount = await manager.rewindPiAgentSession('pi-rewind-source', 'assistant-keep')

    expect(retainedCount).toBe(2)
    expect(manager.getAgentSessionMeta('pi-rewind-source')?.piEntryBindings).toEqual({ 'assistant-keep': 'entry-keep' })
    expect(manager.getAgentSessionSDKMessages('pi-rewind-source').map((message) => (message as { uuid?: string }).uuid))
      .toEqual(['user-1', 'assistant-keep'])
  })
})

describe('Agent 会话引用 prompt', () => {
  test('Given 用户显式引用跨工作区会话 When 构建发送 prompt Then 保留该会话上下文', () => {
    writeAgentSessionsIndex([
      { id: 'current-session', title: '当前工作区会话', workspaceId: 'workspace-a', createdAt: 1, updatedAt: 1 },
      { id: 'other-workspace-session', title: '其他工作区会话', workspaceId: 'workspace-b', createdAt: 2, updatedAt: 2 },
    ])

    const processWithResourcesPath = process as NodeJS.Process & { resourcesPath?: string }
    const originalResourcesPath = processWithResourcesPath.resourcesPath
    processWithResourcesPath.resourcesPath = tempHome
    try {
      const prompt = contextPrompt.buildReferencedSessionsPrompt(
        'current-session',
        ['other-workspace-session'],
      )

      expect(prompt).toContain('id="other-workspace-session"')
      expect(prompt).toContain('title="其他工作区会话"')
      expect(prompt).not.toContain('同工作区')
    } finally {
      Object.defineProperty(processWithResourcesPath, 'resourcesPath', {
        value: originalResourcesPath,
        configurable: true,
        writable: true,
      })
    }
  })
})

describe('Agent 会话删除墓碑', () => {
  test('Given 已删除会话的晚到 SDK 输出 When 追加 Then 不重新创建 transcript', () => {
    const id = 'deleted-session-late-output'
    writeAgentSessionsIndex([{ id, title: '待删除会话', workspaceId: 'workspace-a', createdAt: 1, updatedAt: 1 }])
    writeAgentSessionJsonl(id, [JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: '原始消息' }] } })])

    manager.markAgentSessionDeleting(id)
    manager.deleteAgentSession(id)
    manager.appendSDKMessages(id, [{ type: 'result', subtype: 'success' } as never])

    expect(manager.getAgentSessionMeta(id)).toBeUndefined()
    expect(existsSync(join(tempHome, '.proma', 'agent-sessions', `${id}.jsonl`))).toBe(false)
  })
})

describe('S7 旧数据往返兼容', () => {
  test('旧 Agent 索引迁移后的日常保存仍能找到逐字节原件，更高版本索引保留原样', async () => {
    const { createHash } = await import('node:crypto')
    const { getAgentSessionsIndexPath } = await import('./config-paths')
    const file = getAgentSessionsIndexPath()
    const old = '\uFEFF' + JSON.stringify({ version: 2, retained: 14, sessions: [{ ...createIndexedSessions(1)[0]!, codexFastMode: true, privateField: 42 }] }, null, 2)
    writeFileSync(file, old)
    expect(manager.getAgentSessionMeta('session-0')?.codexSpeed).toBe('fast')
    manager.updateAgentSessionMeta('session-0', { title: '更新标题' })
    const backup = `${file}.pre-v2-${createHash('sha256').update(old).digest('hex')}.bak`
    expect(readFileSync(backup, 'utf8')).toBe(old)
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ version: 3, retained: 14, sessions: [{ privateField: 42 }] })
    const future = JSON.stringify({ version: 100, sessions: [], future: '未来格式' })
    writeFileSync(file, future)
    expect(() => manager.listAgentSessions()).toThrow('版本')
    expect(readFileSync(file, 'utf8')).toBe(future)
  })

  test('升级已启用和已停用的默认 Skill 时保留用户选择，再次启动可继续使用', async () => {
    const paths = await import('./config-paths')
    const { upgradeDefaultSkillsInWorkspaces } = await import('./agent-workspace-manager')
    const slug = 'skill-upgrade'
    writeAgentWorkspacesIndex([{ id: slug, slug, name: '旧工作区', createdAt: 1, updatedAt: 1 }])
    const active = paths.getWorkspaceSkillsDir(slug)
    const inactive = paths.getInactiveSkillsDir(slug)
    for (const [name, oldVersion, location] of [
      ['knowledge-maintenance', '1.0.3', active], ['tool-builder', '1.0.1', inactive], ['in-app-browser', '1.1.1', active],
      ['proma-build-in-proma-app', null, active],
    ] as const) {
      const bundled = join(paths.getDefaultSkillsDir(), name)
      mkdirSync(bundled, { recursive: true })
      const contents = readFileSync(join(import.meta.dir, '../../../default-skills', name, 'SKILL.md'), 'utf8')
      writeFileSync(join(bundled, 'SKILL.md'), contents)
      if (oldVersion === null) continue
      mkdirSync(join(location, name), { recursive: true })
      writeFileSync(join(location, name, 'SKILL.md'), `---\nname: ${name}\nversion: "${oldVersion}"\n---\n旧版`)
    }
    upgradeDefaultSkillsInWorkspaces()
    upgradeDefaultSkillsInWorkspaces()
    expect(paths.parseSkillVersion(join(active, 'knowledge-maintenance'))).toBe('1.0.4')
    expect(paths.parseSkillVersion(join(inactive, 'tool-builder'))).toBe('1.0.2')
    expect(existsSync(join(active, 'tool-builder'))).toBe(false)
    expect(paths.parseSkillVersion(join(active, 'in-app-browser'))).toBe('1.1.2')
    expect(paths.parseSkillVersion(join(active, 'proma-build-in-proma-app'))).toBe('1.0.0')
  })
})
