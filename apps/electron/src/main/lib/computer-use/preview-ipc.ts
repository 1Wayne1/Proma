import { app, ipcMain } from 'electron'
import type { IpcMainInvokeEvent, WebContents } from 'electron'
import { DESKTOP_PREVIEW_IPC } from '@proma/shared'
import type { DesktopPreviewCommand } from '@proma/shared'
import { getMainWindowRenderer } from '../main-window-store'
import { desktopPreviews } from './preview-runtime'

export function registerDesktopPreviewIpc(isVisibleSession: (sender: WebContents, sessionId: string) => boolean): void {
  const authorized = (event: IpcMainInvokeEvent, sessionId: unknown): sessionId is string => {
    const target = getMainWindowRenderer()
    return typeof sessionId === 'string' && sessionId.length <= 128 && !!target && event.sender === target.window.webContents &&
      !!event.senderFrame && event.senderFrame === event.sender.mainFrame && event.senderFrame.url === target.entryUrl &&
      target.window.isVisible() && !target.window.isMinimized() && isVisibleSession(event.sender, sessionId)
  }
  ipcMain.handle(DESKTOP_PREVIEW_IPC.state, (event, sessionId: unknown) => authorized(event, sessionId) ? desktopPreviews.state(sessionId) : null)
  ipcMain.handle(DESKTOP_PREVIEW_IPC.command, async (event, input: DesktopPreviewCommand) => {
    if (!input || !authorized(event, input.sessionId) || typeof input.id !== 'string' ||
        !['frame', 'stop', 'activate', 'retry'].includes(input.action)) return null
    const frame = await desktopPreviews.command(input)
    return authorized(event, input.sessionId) && desktopPreviews.state(input.sessionId)?.id === input.id ? frame : null
  })
  app.once('before-quit', () => {
    desktopPreviews.closeAll()
    ipcMain.removeHandler(DESKTOP_PREVIEW_IPC.state)
    ipcMain.removeHandler(DESKTOP_PREVIEW_IPC.command)
  })
}
