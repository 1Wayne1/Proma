import { app, ipcMain, shell } from 'electron'
import type { IpcMainInvokeEvent } from 'electron'
import { PRESENT_IPC_CHANNELS } from '@proma/shared'
import type { PresentAction, PresentActionResult, PresentReceipt, PresentTurn } from '@proma/shared'
import { browserController } from './browser-controller'
import { resolveBrowserProfileKey } from './browser-profile-policy'
import { openDetachedPreviewWindow, closePresentationPreviews } from './detached-preview-window'
import { getAgentSessionMeta } from './agent-session-manager'
import { getMainWindow } from './main-window-store'
import { presentService } from './present-runtime'
import { dirname } from 'node:path'

function assertMain(event: IpcMainInvokeEvent): void {
  if (!event.senderFrame || event.senderFrame !== event.sender.mainFrame || getMainWindow()?.webContents !== event.sender) {
    throw new Error('仅主窗口可以操作交付卡片')
  }
}

function owner(input: PresentTurn): PresentTurn {
  if (!input || typeof input.sessionId !== 'string' || !input.sessionId || input.sessionId.length > 128 ||
    typeof input.turnId !== 'string' || !input.turnId || input.turnId.length > 128) throw new Error('交付轮次无效')
  return { sessionId: input.sessionId, turnId: input.turnId }
}

export function purgePresentSession(sessionId: string): void {
  closePresentationPreviews(sessionId)
  try { presentService.purgeSession(sessionId) } catch (error) { console.warn('[交付] 会话记录清理失败:', error) }
}

export function registerPresentIpc(): void {
  ipcMain.handle(PRESENT_IPC_CHANNELS.LIST, (event, input: PresentTurn) => {
    assertMain(event)
    return presentService.list(owner(input))
  })
  ipcMain.handle(PRESENT_IPC_CHANNELS.ACT, async (event, input: PresentAction): Promise<PresentActionResult> => {
    assertMain(event)
    const turn = owner(input)
    if (typeof input.resourceId !== 'string' || !/^[a-f0-9]{64}$/.test(input.resourceId)) throw new Error('交付资源无效')
    if (input.action === 'cancel') {
      presentService.cancel(turn, input.resourceId)
      return {}
    }
    if (input.action !== 'open' && input.action !== 'locate' && input.action !== 'vault' && input.action !== 'browser') throw new Error('展示操作无效')
    const attempt = presentService.begin(turn, input.resourceId, input.action)
    if (attempt.vault) return { vault: attempt.vault }
    const validate = (): string => presentService.verify(attempt)
    try {
      const path = validate()
      if (input.action === 'locate') {
        shell.showItemInFolder(path)
        presentService.settle(attempt, 'presented')
      } else if (input.action === 'browser') {
        const session = getAgentSessionMeta(turn.sessionId)
        browserController.configureSession(turn.sessionId, { profileKey: resolveBrowserProfileKey(session?.workspaceId, turn.sessionId) })
        let previewTabId: string | undefined
        await browserController.previewOpen(turn.sessionId, path, undefined, [attempt.resource.boundary], undefined, attempt.signal, {
          validate, onTabCreated: id => { previewTabId = id },
        })
        try {
          assertMain(event)
          if (!previewTabId || !presentService.settle(attempt, 'presented')) throw new Error('展示请求已结束')
          return { browserTabId: previewTabId }
        } catch (error) {
          if (previewTabId) await browserController.closeTab(turn.sessionId, previewTabId).catch(() => {})
          throw error
        }
      } else {
        const id = openDetachedPreviewWindow({ sessionId: turn.sessionId, filePath: path, dirPath: dirname(path), previewOnly: true, readOnly: true }, getMainWindow(), {
          requestId: attempt.id,
          validate,
          signal: attempt.signal,
          ready: () => { if (!presentService.settle(attempt, 'presented')) throw new Error('展示请求已结束') },
          closed: () => { try { presentService.settle(attempt, 'cancelled') } catch { /* 会话可能已被清理。 */ } },
        })
        if (!id) throw new Error('无法打开交付文件预览')
      }
      return {}
    } catch (error) {
      presentService.settle(attempt, 'cancelled')
      throw error
    }
  })
  ipcMain.handle(PRESENT_IPC_CHANNELS.RECEIPT, (event, input: PresentReceipt) => {
    assertMain(event)
    const turn = owner(input)
    if (typeof input.requestId !== 'string' || (input.outcome !== 'presented' && input.outcome !== 'cancelled')) throw new Error('展示回执无效')
    return presentService.vaultReceipt(turn, input.requestId, input.outcome)
  })
  app.once('will-quit', () => {
    for (const channel of Object.values(PRESENT_IPC_CHANNELS)) {
      if (channel !== PRESENT_IPC_CHANNELS.CHANGED) ipcMain.removeHandler(channel)
    }
  })
}
