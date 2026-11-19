/**
 * 旧版 Chat 只读兼容 IPC 注册
 *
 * 仅允许主窗口主 frame 调用，且在应用退出前注销全部 handler。
 */

import { app, ipcMain } from 'electron'
import type { IpcMainInvokeEvent } from 'electron'
import { LEGACY_CHAT_IPC_CHANNELS } from '@proma/shared'
import type { LegacyChatHistoryQuery, LegacyChatSnapshotKind } from '@proma/shared'
import { getMainWindow } from './main-window-store'
import type { LegacyChatService } from './legacy-chat-service'

function assertLegacyChatOwner(event: IpcMainInvokeEvent): void {
  const main = getMainWindow()
  if (!main || main.webContents !== event.sender || event.senderFrame !== event.sender.mainFrame) {
    throw new Error('仅主窗口可以访问历史 Chat 只读导出')
  }
}

export function registerLegacyChatIpc(service: LegacyChatService): () => void {
  ipcMain.handle(LEGACY_CHAT_IPC_CHANNELS.GET_SUMMARY, (event) => {
    assertLegacyChatOwner(event)
    return service.getSummary()
  })

  ipcMain.handle(LEGACY_CHAT_IPC_CHANNELS.LIST_HISTORY, (event, query?: LegacyChatHistoryQuery) => {
    assertLegacyChatOwner(event)
    return service.listHistory(query)
  })

  ipcMain.handle(
    LEGACY_CHAT_IPC_CHANNELS.PREPARE_SESSION,
    (event, sessionId: string, kind: LegacyChatSnapshotKind, conversationId?: string) => {
      assertLegacyChatOwner(event)
      if (
        typeof sessionId !== 'string'
        || (kind !== 'history' && kind !== 'tools')
        || (conversationId !== undefined && typeof conversationId !== 'string')
      ) {
        throw new Error('旧 Chat 快照参数无效')
      }
      return service.prepareSession(sessionId, kind, conversationId)
    },
  )

  let cleaned = false
  const cleanup = (): void => {
    if (cleaned) return
    cleaned = true
    for (const channel of Object.values(LEGACY_CHAT_IPC_CHANNELS)) {
      ipcMain.removeHandler(channel)
    }
  }

  app.once('before-quit', cleanup)
  return cleanup
}
