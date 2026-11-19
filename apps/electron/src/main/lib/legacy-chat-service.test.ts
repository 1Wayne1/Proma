import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import * as os from 'node:os'
import { join } from 'node:path'
import {
  LEGACY_CHAT_LIMITS,
  createLegacyChatService,
  type LegacyChatSessionLike,
  type LegacyChatWorkspaceLike,
} from './legacy-chat-service'

interface FixtureContext {
  configDir: string
  sessions: Map<string, LegacyChatSessionLike>
  workspaces: Map<string, LegacyChatWorkspaceLike>
  deleting: Set<string>
}

const SESSION_ID = '11111111-1111-4111-8111-111111111111'
const WORKSPACE_ID = 'ws-legacy'
const WORKSPACE_SLUG = 'legacy-project'

function createFixtureContext(): FixtureContext {
  const configDir = realpathSync(mkdtempSync(join(os.tmpdir(), 'proma-legacy-chat-')))
  const sessions = new Map<string, LegacyChatSessionLike>([
    [SESSION_ID, { id: SESSION_ID, workspaceId: WORKSPACE_ID }],
  ])
  const workspaces = new Map<string, LegacyChatWorkspaceLike>([
    [WORKSPACE_ID, { id: WORKSPACE_ID, slug: WORKSPACE_SLUG }],
  ])
  const deleting = new Set<string>()
  mkdirSync(join(configDir, 'agent-workspaces', WORKSPACE_SLUG, SESSION_ID), { recursive: true })
  return { configDir, sessions, workspaces, deleting }
}

function createServiceFromContext(ctx: FixtureContext) {
  return createLegacyChatService({
    configDir: ctx.configDir,
    getSession: id => ctx.sessions.get(id),
    getWorkspace: id => ctx.workspaces.get(id),
    isSessionDeleting: id => ctx.deleting.has(id),
  })
}

function snapshotFileStats(paths: string[]): Array<{ path: string; bytes: Buffer; mtimeMs: number; ino: number }> {
  return paths.map((filePath) => {
    const stat = statSync(filePath)
    return {
      path: filePath,
      bytes: readFileSync(filePath),
      mtimeMs: stat.mtimeMs,
      ino: stat.ino,
    }
  })
}

describe('legacy-chat-service 只读兼容导出服务', () => {
  let ctx: FixtureContext

  beforeEach(() => {
    ctx = createFixtureContext()
  })

  afterEach(() => {
    rmSync(ctx.configDir, { recursive: true, force: true })
  })

  test('Given 缺少原始索引和工具配置 When 查询摘要与列表 Then 返回 missing 且不创建任何缺失文件或目录', () => {
    const service = createServiceFromContext(ctx)

    expect(service.getSummary()).toEqual({
      scope: 'local-device',
      conversationCount: 0,
      customToolCount: 0,
      historyStatus: 'missing',
      toolsStatus: 'missing',
    })
    expect(service.listHistory()).toEqual({
      items: [],
      total: 0,
      offset: 0,
      limit: 20,
      status: 'missing',
    })

    expect(existsSync(join(ctx.configDir, 'conversations.json'))).toBe(false)
    expect(existsSync(join(ctx.configDir, 'conversations'))).toBe(false)
    expect(existsSync(join(ctx.configDir, 'chat-tools.json'))).toBe(false)
  })

  test('Given 含 UTF-8 BOM 的有效与部分损坏索引 When 查询摘要与分页检索 Then 保留可用记录并拒绝非法查询参数', () => {
    const conversationsPath = join(ctx.configDir, 'conversations.json')
    writeFileSync(
      conversationsPath,
      '\uFEFF' + JSON.stringify({
        conversations: [
          { id: 'c1', title: 'Alpha 设计方案', createdAt: 100, updatedAt: 300, archived: false },
          { id: 'c2', title: 'Beta 归档总结', createdAt: 200, updatedAt: 400, archived: true },
          { id: 'c1', title: 'Alpha 修订版', createdAt: 100, updatedAt: 500, archived: false },
          { id: '../bad-id', title: '非法路径 ID' },
          'not-an-object',
        ],
      }),
      'utf8',
    )
    const toolsPath = join(ctx.configDir, 'chat-tools.json')
    writeFileSync(
      toolsPath,
      '\uFEFF' + JSON.stringify({
        customTools: [
          { category: 'builtin', id: 'web-search', name: 'BuiltIn', description: '内置', params: [] },
          { category: 'custom', id: 'my-tool', name: 'My Tool', description: '自定义', params: [] },
        ],
      }),
      'utf8',
    )

    const service = createServiceFromContext(ctx)
    expect(service.getSummary()).toEqual({
      scope: 'local-device',
      conversationCount: 3,
      customToolCount: 1,
      historyStatus: 'invalid',
      toolsStatus: 'available',
    })

    // 去重后 c1 仅保留后者（updatedAt: 500），先按时间倒序再按 id 升序
    const allPage = service.listHistory({ query: 'alpha', archived: 'active', offset: 0, limit: 10 })
    expect(allPage).toEqual({
      items: [
        { id: 'c1', title: 'Alpha 修订版', createdAt: 100, updatedAt: 500, archived: false },
      ],
      total: 1,
      offset: 0,
      limit: 10,
      status: 'invalid',
    })

    const archivedPage = service.listHistory({ archived: 'archived' })
    expect(archivedPage.items.map(item => item.id)).toEqual(['c2'])

    expect(() => service.listHistory({ query: 'x'.repeat(201) })).toThrow('查询参数无效')
    expect(() => service.listHistory({ offset: -1 })).toThrow('查询参数无效')
    expect(() => service.listHistory({ limit: 101 })).toThrow('查询参数无效')
    expect(() => service.listHistory({ limit: 0 })).toThrow('查询参数无效')
    expect(() => service.listHistory({ archived: 'unknown' as 'all' })).toThrow('查询参数无效')
  })

  test('Given 历史对话含 BOM/CRLF、坏行、超长行、超大附件清单及缺失文件 When 准备会话快照 Then 按安全上限导出并原文件逐字节不变', () => {
    const convDir = join(ctx.configDir, 'conversations')
    mkdirSync(convDir, { recursive: true })
    const conversationsPath = join(ctx.configDir, 'conversations.json')
    const jsonlC1 = join(convDir, 'conv-1.jsonl')
    const toolsPath = join(ctx.configDir, 'chat-tools.json')

    writeFileSync(
      conversationsPath,
      JSON.stringify({
        conversations: [
          { id: 'conv-1', title: '研究笔记', createdAt: 10, updatedAt: 20, archived: false },
          { id: 'conv-missing', title: '缺失正文文件', createdAt: 5, updatedAt: 15, archived: true },
        ],
      }),
      'utf8',
    )

    const manyAttachments = Array.from({ length: 105 }, (_, i) => ({
      filename: i === 0 ? 'C:\\Users\\demo\\secret\\report.pdf' : `/tmp/dir/file-${i}.png`,
      localPath: 'secret/local/path',
      url: 'https://internal.example.test/secret',
      mediaType: i === 0 ? 'application/pdf' : 'bad type with space',
    }))
    const validUser = JSON.stringify({
      role: 'user',
      content: '第一条问题',
      createdAt: 11,
      attachments: manyAttachments,
    })
    const systemMsg = JSON.stringify({ role: 'system', content: '应忽略的系统消息' })
    const oversizeLine = JSON.stringify({
      role: 'assistant',
      content: 'A'.repeat(LEGACY_CHAT_LIMITS.lineBytes + 128),
    })
    const validAssistant = JSON.stringify({
      role: 'assistant',
      content: '第一条回答',
      createdAt: 12,
    })
    writeFileSync(
      jsonlC1,
      `\uFEFF${validUser}\r\n{损坏行\r\n${systemMsg}\r\n${oversizeLine}\r\n${validAssistant}`,
      'utf8',
    )
    writeFileSync(toolsPath, JSON.stringify({ customTools: [] }), 'utf8')

    const beforeStats = snapshotFileStats([conversationsPath, jsonlC1, toolsPath])
    const service = createServiceFromContext(ctx)

    // 单条导出
    const single = service.prepareSession(SESSION_ID, 'history', 'conv-1')
    expect(single.kind).toBe('history')
    expect(single.itemCount).toBe(1)
    expect(single.conversation).toEqual({
      id: 'conv-1',
      title: '研究笔记',
      createdAt: 10,
      updatedAt: 20,
      archived: false,
    })
    expect(single.warnings.some(w => w.includes('损坏或结构无效'))).toBe(true)
    expect(single.warnings.some(w => w.includes('超大'))).toBe(true)
    expect(single.warnings.some(w => w.includes('超过 100 项'))).toBe(true)

    const manifest = JSON.parse(readFileSync(single.entryPath, 'utf8'))
    expect(manifest.untrustedData).toBe(true)
    expect(manifest.scope).toBe('local-device')
    expect(manifest.sourceItemCount).toBe(1)
    expect(manifest.conversations[0].messagesExported).toBe(2)

    const exportedLines = readFileSync(join(single.directory, 'conversation-000001.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map(line => JSON.parse(line))
    expect(exportedLines).toHaveLength(2)
    expect(exportedLines[0].untrustedData).toBe(true)
    expect(exportedLines[0].attachments).toHaveLength(100)
    expect(exportedLines[0].attachments[0]).toEqual({ name: 'report.pdf', mediaType: 'application/pdf' })
    expect(exportedLines[0].attachments[1].mediaType).toBe('application/octet-stream')
    expect(JSON.stringify(exportedLines[0])).not.toContain('internal.example.test')
    expect(JSON.stringify(exportedLines[0])).not.toContain('Users')

    // 全部历史导出包含缺失文件警告
    const allHistory = service.prepareSession(SESSION_ID, 'history')
    expect(allHistory.itemCount).toBe(2)
    expect(allHistory.warnings.some(w => w.includes('消息文件缺失'))).toBe(true)

    // 原文件 mtime/ino/字节完全不变
    const afterStats = snapshotFileStats([conversationsPath, jsonlC1, toolsPath])
    expect(afterStats).toEqual(beforeStats)
  })

  test('Given 非法参数、只读历史会话、删除中会话或不存在的对象 When 准备会话快照 Then 立即拒绝且不创建空快照目录', () => {
    writeFileSync(
      join(ctx.configDir, 'conversations.json'),
      JSON.stringify({ conversations: [{ id: 'c1', title: 'One' }] }),
      'utf8',
    )
    const service = createServiceFromContext(ctx)
    const workbench = join(ctx.configDir, 'agent-workspaces', WORKSPACE_SLUG, SESSION_ID)

    expect(() => service.prepareSession('not-uuid', 'history')).toThrow('Agent 会话 ID 无效')
    expect(() => service.prepareSession(SESSION_ID, 'other' as 'history')).toThrow('快照类型无效')
    expect(() => service.prepareSession(SESSION_ID, 'tools', 'c1')).toThrow('记录 ID 无效')
    expect(() => service.prepareSession(SESSION_ID, 'history', '../bad')).toThrow('记录 ID 无效')
    expect(() => service.prepareSession(SESSION_ID, 'history', 'missing-id')).toThrow('已不存在或无法读取')

    ctx.deleting.add(SESSION_ID)
    expect(() => service.prepareSession(SESSION_ID, 'history')).toThrow('不可用')
    ctx.deleting.delete(SESSION_ID)

    ctx.sessions.set(SESSION_ID, {
      id: SESSION_ID,
      workspaceId: WORKSPACE_ID,
      legacyTranscript: { sourceRuntime: 'claude', continuationRequired: true },
    })
    expect(() => service.prepareSession(SESSION_ID, 'history')).toThrow('只读')

    // 校验缺失 conversationId 与上述守卫未在 workbench 下创建遗留空快照目录
    expect(readdirSync(workbench)).toEqual([])
  })

  test('Given 符号链接或硬链接的源文件或工作台 When 读取或准备快照 Then 安全校验拦截并拒绝泄露', () => {
    const outsideFile = join(ctx.configDir, 'outside-secret.json')
    writeFileSync(
      outsideFile,
      JSON.stringify({ conversations: [{ id: 's1', title: 'secret' }] }),
      'utf8',
    )
    // 软链接源索引
    symlinkSync(outsideFile, join(ctx.configDir, 'conversations.json'))
    // 硬链接工具配置
    const hardlinkTarget = join(ctx.configDir, 'hardlink-origin.json')
    writeFileSync(hardlinkTarget, JSON.stringify({ customTools: [] }), 'utf8')
    linkSync(hardlinkTarget, join(ctx.configDir, 'chat-tools.json'))

    const service = createServiceFromContext(ctx)
    expect(service.getSummary()).toEqual({
      scope: 'local-device',
      conversationCount: 0,
      customToolCount: 0,
      historyStatus: 'invalid',
      toolsStatus: 'invalid',
    })

    // 替换为合法 JSON 但 JSONL 为硬链接时，导出文本为空且带安全警告
    rmSync(join(ctx.configDir, 'conversations.json'))
    writeFileSync(
      join(ctx.configDir, 'conversations.json'),
      JSON.stringify({ conversations: [{ id: 's1', title: 'Hardlink Test' }] }),
      'utf8',
    )
    const convDir = join(ctx.configDir, 'conversations')
    mkdirSync(convDir, { recursive: true })
    const secretMsg = join(ctx.configDir, 'secret-msg.jsonl')
    writeFileSync(secretMsg, JSON.stringify({ role: 'user', content: '机密内容' }), 'utf8')
    linkSync(secretMsg, join(convDir, 's1.jsonl'))

    const prep = service.prepareSession(SESSION_ID, 'history', 's1')
    expect(readFileSync(join(prep.directory, 'conversation-000001.jsonl'), 'utf8')).toBe('')
    expect(prep.warnings.some(w => w.includes('不安全'))).toBe(true)

    // 符号链接工作台目录应直接报错
    const workbench = join(ctx.configDir, 'agent-workspaces', WORKSPACE_SLUG, SESSION_ID)
    rmSync(workbench, { recursive: true, force: true })
    const realElsewhere = realpathSync(mkdtempSync(join(os.tmpdir(), 'proma-symlink-wb-')))
    try {
      symlinkSync(realElsewhere, workbench)
      expect(() => service.prepareSession(SESSION_ID, 'history')).toThrow('链接')
    } finally {
      rmSync(realElsewhere, { recursive: true, force: true })
    }
  })

  test('Given 自定义工具含 URL/请求头/请求体与旧凭据 When 导出 tools 快照 Then 全部敏感常量脱敏且超限时触发 fail-closed', () => {
    const toolsPath = join(ctx.configDir, 'chat-tools.json')
    writeFileSync(
      toolsPath,
      JSON.stringify({
        toolCredentials: { 'weather-api': { token: 'super-secret-token-xyz' } },
        customTools: [
          {
            category: 'builtin',
            id: 'builtin-search',
            name: 'Search',
            description: '内置工具',
            params: [],
          },
          {
            category: 'custom',
            id: 'weather-api',
            name: '天气查询 https://api.internal.example/v1',
            description: '使用 super-secret-token-xyz 调用 api.internal.example 查询城市天气',
            params: [
              { name: 'city', type: 'string', description: '目标城市', required: true },
              { name: 'invalid name', type: 'string', description: '应被忽略' },
              { name: 'flag', type: 'unsupported', description: '不支持类型' },
            ],
            httpConfig: {
              method: 'POST',
              urlTemplate: 'https://user:pass@api.internal.example/v1/{{city}}?api_key=abc123',
              headers: { Authorization: 'Bearer header-secret-999' },
              bodyTemplate: '{"city":"{{city}}","tenant":"corp-secret-id"}',
              resultPath: 'data.forecast',
            },
          },
        ],
      }),
      'utf8',
    )

    const before = snapshotFileStats([toolsPath])
    const service = createServiceFromContext(ctx)
    const prep = service.prepareSession(SESSION_ID, 'tools')
    expect(prep.kind).toBe('tools')
    expect(prep.itemCount).toBe(1)

    const manifestText = readFileSync(prep.entryPath, 'utf8')
    const manifest = JSON.parse(manifestText)
    expect(manifest.untrustedData).toBe(true)
    expect(manifest.tools).toHaveLength(1)
    const exportedTool = manifest.tools[0]
    expect(exportedTool.metadataOmittedForSafety).toBe(false)
    expect(exportedTool.legacyCredentialsConfigured).toBe(true)
    expect(exportedTool.authenticationConfigured).toBe(true)
    expect(exportedTool.outputExtractionNeedsReview).toBe(true)
    expect(exportedTool.omittedParameters).toBe(2)
    expect(Object.keys(exportedTool.parameters.properties)).toEqual(['city'])
    expect(exportedTool.configurationNeeded.map((c: { environmentVariable: string }) => c.environmentVariable)).toEqual([
      'PROMA_LEGACY_TOOL_1_URL',
      'PROMA_LEGACY_TOOL_1_HEADERS_JSON',
      'PROMA_LEGACY_TOOL_1_BODY_TEMPLATE',
    ])
    expect(manifestText).not.toContain('super-secret-token-xyz')
    expect(manifestText).not.toContain('header-secret-999')
    expect(manifestText).not.toContain('corp-secret-id')
    expect(manifestText).not.toContain('api.internal.example')
    expect(manifestText).toContain('[已省略配置值]')
    expect(snapshotFileStats([toolsPath])).toEqual(before)

    // 超深嵌套对象应触发 fail-closed，清空自由文本和参数
    let deep: Record<string, unknown> = { leaf: 'secret' }
    for (let i = 0; i < 70; i++) deep = { child: deep }
    writeFileSync(
      toolsPath,
      JSON.stringify({
        toolCredentials: deep,
        customTools: [
          {
            category: 'custom',
            id: 'weather-api',
            name: '真实名称',
            description: '真实描述',
            params: [{ name: 'city', type: 'string', description: '城市' }],
          },
        ],
      }),
      'utf8',
    )
    const beforeFailClosed = snapshotFileStats([toolsPath])
    const failClosedPrep = service.prepareSession(SESSION_ID, 'tools')
    const failClosedManifest = JSON.parse(readFileSync(failClosedPrep.entryPath, 'utf8'))
    expect(failClosedManifest.tools[0].metadataOmittedForSafety).toBe(true)
    expect(failClosedManifest.tools[0].id).toBe('legacy-tool-1')
    expect(failClosedManifest.tools[0].name).toBe('旧工具 1')
    expect(failClosedManifest.tools[0].description).toBe('')
    expect(failClosedManifest.tools[0].parameters.properties).toEqual({})
    expect(failClosedPrep.warnings.some(w => w.includes('已安全省略全部自由文本和参数'))).toBe(true)
    expect(snapshotFileStats([toolsPath])).toEqual(beforeFailClosed)
  })
})
