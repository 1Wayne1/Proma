import { app, ipcMain } from 'electron'
import type { IpcMainInvokeEvent } from 'electron'
import { TURN_CHANGES_IPC_CHANNELS } from '@proma/shared'
import { getMainWindow } from '../main-window-store'
import { getAgentSessionMeta, isAgentSessionDeleting } from '../agent-session-manager'
import { getAgentWorkspace } from '../agent-workspace-manager'
import { getTurnChangeRecorder, subscribeTurnChanges } from './service'
import { TurnChangesQueries } from './query'

function assertMainFrame(event: IpcMainInvokeEvent): void {
  if (getMainWindow()?.webContents !== event.sender || event.senderFrame !== event.sender.mainFrame) throw new Error('仅主窗口可查询逐轮变更')
}

export function registerTurnChangesIpcHandlers(): void {
  const release = subscribeTurnChanges(owner => {
    const main = getMainWindow()
    if (main && !main.webContents.isDestroyed()) main.webContents.send(TURN_CHANGES_IPC_CHANNELS.CHANGED, owner)
  })
  app.once('will-quit', () => {
    release()
    ipcMain.removeHandler(TURN_CHANGES_IPC_CHANNELS.LIST)
    ipcMain.removeHandler(TURN_CHANGES_IPC_CHANNELS.GET_DIFF)
  })
  const queries = (): TurnChangesQueries => new TurnChangesQueries(getTurnChangeRecorder().store, sessionId => {
    const meta = getAgentSessionMeta(sessionId)
    if (!meta?.workspaceId || isAgentSessionDeleting(sessionId) || !getAgentWorkspace(meta.workspaceId)) return undefined
    return { sessionId: meta.id, workspaceId: meta.workspaceId }
  })
  ipcMain.handle(TURN_CHANGES_IPC_CHANNELS.LIST, async (event, input: unknown) => {
    assertMainFrame(event)
    try { const result = await queries().list(input); assertMainFrame(event); return result }
    catch { throw new Error('无法读取本轮变更，请确认会话仍然存在后重试') }
  })
  ipcMain.handle(TURN_CHANGES_IPC_CHANNELS.GET_DIFF, async (event, input: unknown) => {
    assertMainFrame(event)
    try { const result = await queries().diff(input); assertMainFrame(event); return result }
    catch { throw new Error('无法读取本轮文件快照，文件可能未被采样或记录已失效') }
  })
}
