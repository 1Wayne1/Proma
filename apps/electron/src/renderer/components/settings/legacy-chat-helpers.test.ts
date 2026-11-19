import { describe, expect, test } from 'bun:test'
import type { AgentSessionMeta, LegacyChatPreparation } from '@proma/shared'
import {
  LEGACY_CHAT_PAGE_SIZE,
  buildLegacyChatPrompt,
  formatLegacyChatTimestamp,
  legacyChatEntryKey,
  reconcileLegacyChatEntry,
  runLegacyChatPreparation,
  type LegacyChatPreparationActions,
  type LegacyChatPreparationEntry,
} from './legacy-chat-helpers'

function makeSession(id: string, title: string, workspaceId?: string): AgentSessionMeta {
  return {
    id,
    title,
    workspaceId,
    createdAt: 1,
    updatedAt: 1,
  }
}

describe('legacy-chat-helpers 纯函数行为', () => {
  test('LEGACY_CHAT_PAGE_SIZE 为 20 且 legacyChatEntryKey 区分工作区、类型与单条对话 ID', () => {
    expect(LEGACY_CHAT_PAGE_SIZE).toBe(20)
    expect(legacyChatEntryKey('ws-1', 'history')).not.toBe(legacyChatEntryKey('ws-1', 'tools'))
    expect(legacyChatEntryKey('ws-1', 'history')).not.toBe(legacyChatEntryKey('ws-2', 'history'))
    expect(legacyChatEntryKey('ws-1', 'history', 'c1')).not.toBe(legacyChatEntryKey('ws-1', 'history'))
    expect(legacyChatEntryKey(null, 'tools')).not.toBe(legacyChatEntryKey('ws-1', 'tools'))
  })

  test('reconcileLegacyChatEntry 在原会话仍位于同一项目时保留引用，否则清空已缓存准备状态', () => {
    const active = makeSession('s1', '旧标题', 'ws-1')
    const prep: LegacyChatPreparation = {
      directory: '/tmp/dir',
      entryPath: '/tmp/dir/manifest.json',
      kind: 'history',
      itemCount: 1,
      warnings: [],
    }
    const entry: LegacyChatPreparationEntry = {
      workspaceId: 'ws-1',
      session: makeSession('s1', '初版', 'ws-1'),
      preparation: prep,
      prefilled: true,
    }

    reconcileLegacyChatEntry(entry, active, 'ws-1')
    expect(entry.session?.title).toBe('旧标题')
    expect(entry.preparation).toBe(prep)
    expect(entry.prefilled).toBe(true)

    // 跨项目或会话被删后清理全部缓存字段
    reconcileLegacyChatEntry(entry, makeSession('s1', '移动后', 'ws-2'), 'ws-1')
    expect(entry.session).toBeUndefined()
    expect(entry.preparation).toBeUndefined()
    expect(entry.prefilled).toBeUndefined()
  })

  test('buildLegacyChatPrompt 对历史列表、单条历史与自定义工具生成安全边界与本地语义提示词', () => {
    const base = {
      directory: '/tmp/a "quote" dir',
      entryPath: '/tmp/a "quote" dir/manifest.json',
      itemCount: 2,
      warnings: [],
    }

    const historyAllPrompt = buildLegacyChatPrompt({ ...base, kind: 'history' })
    expect(historyAllPrompt).toContain(JSON.stringify(base.entryPath))
    expect(historyAllPrompt).toContain(JSON.stringify(base.directory))
    expect(historyAllPrompt).toContain('不可信数据')
    expect(historyAllPrompt).toContain('此设备上的旧 Chat')
    expect(historyAllPrompt).not.toContain('云')

    const singlePrompt = buildLegacyChatPrompt({
      ...base,
      kind: 'history',
      conversation: {
        id: 'conv-1',
        title: '包含 "引号" 的标题',
        createdAt: 1,
        updatedAt: 2,
        archived: false,
      },
    })
    expect(singlePrompt).toContain(JSON.stringify({ id: 'conv-1', title: '包含 "引号" 的标题' }))
    expect(singlePrompt).toContain('不要搜索或导出其他旧对话')

    const toolsPrompt = buildLegacyChatPrompt({ ...base, kind: 'tools' })
    expect(toolsPrompt).toContain('转换为当前项目可复用的 Skills')
    expect(toolsPrompt).toContain('skill-creator')
    expect(toolsPrompt).toContain('不覆盖同名 Skill')
  })

  test('runLegacyChatPreparation 幂等复用已创建会话、快照与预填，并在准备失败后不重复建会话', async () => {
    const calls: string[] = []
    let shouldFailPrepare = true
    const created = makeSession('sess-1', '读取历史 Chat', 'ws-1')
    const prepared: LegacyChatPreparation = {
      directory: '/tmp/snap',
      entryPath: '/tmp/snap/manifest.json',
      kind: 'history',
      itemCount: 3,
      warnings: [],
    }
    const entry: LegacyChatPreparationEntry = { workspaceId: 'ws-1' }

    const actions: LegacyChatPreparationActions = {
      create: async (title) => {
        calls.push(`create:${title}`)
        return created
      },
      prepare: async (sessionId, kind, conversationId) => {
        calls.push(`prepare:${sessionId}:${kind}:${conversationId ?? ''}`)
        if (shouldFailPrepare) throw new Error('磁盘繁忙')
        return prepared
      },
      prefill: (sessionId) => {
        calls.push(`prefill:${sessionId}`)
      },
      open: (session) => {
        calls.push(`open:${session.id}`)
      },
    }

    await expect(runLegacyChatPreparation('history', entry, actions)).rejects.toThrow('磁盘繁忙')
    expect(calls).toEqual(['create:读取历史 Chat', 'prepare:sess-1:history:'])
    expect(entry.session?.id).toBe('sess-1')
    expect(entry.preparation).toBeUndefined()

    // 失败重试时直接复用 sess-1，不再调用 create
    shouldFailPrepare = false
    const firstResult = await runLegacyChatPreparation('history', entry, actions)
    expect(firstResult).toBe(prepared)
    expect(calls).toEqual([
      'create:读取历史 Chat',
      'prepare:sess-1:history:',
      'prepare:sess-1:history:',
      'prefill:sess-1',
      'open:sess-1',
    ])

    // 再次点击仅重新打开会话
    await runLegacyChatPreparation('history', entry, actions)
    expect(calls).toEqual([
      'create:读取历史 Chat',
      'prepare:sess-1:history:',
      'prepare:sess-1:history:',
      'prefill:sess-1',
      'open:sess-1',
      'open:sess-1',
    ])
  })

  test('formatLegacyChatTimestamp 格式化有效时间并在 null/NaN 时返回时间未知', () => {
    expect(formatLegacyChatTimestamp(null)).toBe('时间未知')
    expect(formatLegacyChatTimestamp(Number.NaN)).toBe('时间未知')
    const formatted = formatLegacyChatTimestamp(Date.UTC(2026, 0, 15, 8, 30))
    expect(formatted).toMatch(/\d{4}\/\d{2}\/\d{2}/)
  })
})
