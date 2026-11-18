import { DESKTOP_PREVIEW_IPC } from '@proma/shared'
import { getMainWindowRenderer } from '../main-window-store'
import { DesktopPreviewRegistry } from './preview'

export const desktopPreviews = new DesktopPreviewRegistry(sessionId => {
  const target = getMainWindowRenderer()
  if (target && target.window.webContents.getURL() === target.entryUrl) {
    target.window.webContents.send(DESKTOP_PREVIEW_IPC.changed, sessionId)
  }
})
