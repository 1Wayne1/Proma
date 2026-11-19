import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LEGACY_CHAT_IPC_CHANNELS } from '@proma/shared'
import { registerLegacyChatIpc } from '../legacy-chat-ipc'
import { createLegacyChatService } from '../legacy-chat-service'
import '../../../preload/index'
import {
  app,
  foreignSender,
  getApi,
  invokeAs,
  mainFrame,
  sender,
  state,
  subFrame,
} from './legacy-chat-ipc-stubs'

const SESSION_ID = '22222222-2222-4222-8222-222222222222'
const WORKSPACE_ID = 'ws-ipc'
const WORKSPACE_SLUG = 'ipc-workspace'

async function verify(): Promise<void> {
  const configDir = realpathSync(mkdtempSync(join(tmpdir(), 'proma-legacy-chat-ipc-root-')))
  try {
    mkdirSync(join(configDir, 'conversations'), { recursive: true })
    mkdirSync(join(configDir, 'agent-workspaces', WORKSPACE_SLUG, SESSION_ID), { recursive: true })
    writeFileSync(
      join(configDir, 'conversations.json'),
      JSON.stringify({ conversations: [{ id: 'c1', title: 'IPC 测试对话', createdAt: 1, updatedAt: 2 }] }),
      'utf8',
    )
    writeFileSync(
      join(configDir, 'conversations', 'c1.jsonl'),
      JSON.stringify({ role: 'user', content: 'hello ipc', createdAt: 1 }),
      'utf8',
    )
    writeFileSync(join(configDir, 'chat-tools.json'), JSON.stringify({ customTools: [] }), 'utf8')

    const cleanup = registerLegacyChatIpc(
      createLegacyChatService({
        configDir,
        getSession: id => (id === SESSION_ID ? { id: SESSION_ID, workspaceId: WORKSPACE_ID } : undefined),
        getWorkspace: id => (id === WORKSPACE_ID ? { id: WORKSPACE_ID, slug: WORKSPACE_SLUG } : undefined),
      }),
    )

    const api = getApi()
    const apiRecord = api as unknown as Record<string, unknown>

    // 确认暴露新版只读入口且已移除旧 Chat / 工具 / 系统提示词 / 迁移入口
    assert.equal(typeof api.getLegacyChatSummary, 'function')
    assert.equal(typeof api.listLegacyChats, 'function')
    assert.equal(typeof api.prepareLegacyChatSession, 'function')
    for (const removedKey of [
      'listConversations',
      'sendMessage',
      'migrateChatToAgent',
      'listSystemPrompts',
      'getChatToolStates',
    ]) {
      assert.equal(removedKey in apiRecord, false, `${removedKey} 应已从 preload 移除`)
    }

    // 主窗口主 frame 调用成功
    const summary = await api.getLegacyChatSummary()
    assert.equal(summary.conversationCount, 1)
    assert.equal(summary.historyStatus, 'available')

    const page = await api.listLegacyChats({ query: 'IPC' })
    assert.equal(page.total, 1)
    assert.equal(page.items[0]?.id, 'c1')

    const prepared = await api.prepareLegacyChatSession(SESSION_ID, 'history', 'c1')
    assert.equal(prepared.kind, 'history')
    assert.equal(prepared.itemCount, 1)
    const manifest = JSON.parse(readFileSync(prepared.entryPath, 'utf8'))
    assert.equal(manifest.untrustedData, true)

    // 参数校验拦截非法 kind / 非字符串参数
    await assert.rejects(
      invokeAs(LEGACY_CHAT_IPC_CHANNELS.PREPARE_SESSION, { sender, senderFrame: mainFrame }, SESSION_ID, 'invalid'),
      /参数无效/,
    )
    await assert.rejects(
      invokeAs(LEGACY_CHAT_IPC_CHANNELS.PREPARE_SESSION, { sender, senderFrame: mainFrame }, 123, 'history'),
      /参数无效/,
    )
    await assert.rejects(
      invokeAs(LEGACY_CHAT_IPC_CHANNELS.PREPARE_SESSION, { sender, senderFrame: mainFrame }, SESSION_ID, 'history', 456),
      /参数无效/,
    )

    // 主窗口 / frame 归属校验拒绝非主窗口及子 frame
    for (const channel of Object.values(LEGACY_CHAT_IPC_CHANNELS)) {
      await assert.rejects(
        invokeAs(channel, { sender, senderFrame: subFrame }),
        /仅主窗口/,
      )
      await assert.rejects(
        invokeAs(channel, { sender: foreignSender, senderFrame: foreignSender.mainFrame }),
        /仅主窗口/,
      )
    }

    state.mainWindow = null
    await assert.rejects(api.getLegacyChatSummary(), /仅主窗口/)
    state.mainWindow = { webContents: sender }

    // before-quit 自动注销全部 handler，再次手动 cleanup 保持幂等
    app.emit('before-quit')
    await assert.rejects(api.getLegacyChatSummary(), /handler not registered/)
    await assert.rejects(api.listLegacyChats(), /handler not registered/)
    await assert.rejects(api.prepareLegacyChatSession(SESSION_ID, 'history'), /handler not registered/)
    cleanup()

    console.log('legacy-chat-ipc: passed')
  } finally {
    rmSync(configDir, { recursive: true, force: true })
  }
}

void verify()
