import { app, ipcMain } from 'electron'
import type { IpcMainInvokeEvent } from 'electron'
import { TURN_CHANGES_IPC_CHANNELS } from '@proma/shared'
import type { RemoveWorktreeInput, RemoveWorktreeResult, TurnFileDiffQuery, TurnRestoreApplyInput } from '@proma/shared'
import { getMainWindow } from '../main-window-store'
import type { TurnRestoreService } from './restore'

/** 所有写操作仅对当前主窗口 main frame 开放；不向 Agent 工具暴露旁路。 */
export function registerTurnOperationsIpcHandlers(options: { restore: TurnRestoreService; removeWorktree: (input: RemoveWorktreeInput, assertCurrent: () => void) => Promise<RemoveWorktreeResult> }): void {
  const assertMain = (event: IpcMainInvokeEvent): void => {
    if (getMainWindow()?.webContents !== event.sender || event.sender.mainFrame !== event.senderFrame) throw new Error('仅主窗口可以恢复文件或移除 worktree')
  }
  ipcMain.handle(TURN_CHANGES_IPC_CHANNELS.PREVIEW_RESTORE, async (event, input: TurnFileDiffQuery) => {
    assertMain(event)
    try { const result = await options.restore.preview(input); assertMain(event); return result }
    catch { throw new Error('无法预览恢复，项目授权、文件路径或快照可能已经失效') }
  })
  ipcMain.handle(TURN_CHANGES_IPC_CHANNELS.APPLY_RESTORE, async (event, input: TurnRestoreApplyInput) => {
    assertMain(event)
    return options.restore.apply(input, () => assertMain(event))
  })
  ipcMain.handle(TURN_CHANGES_IPC_CHANNELS.REMOVE_WORKTREE, async (event, input: RemoveWorktreeInput) => {
    assertMain(event)
    return options.removeWorktree(input, () => assertMain(event))
  })
  app.once('will-quit', () => {
    options.restore.clear()
    for (const channel of [TURN_CHANGES_IPC_CHANNELS.PREVIEW_RESTORE, TURN_CHANGES_IPC_CHANNELS.APPLY_RESTORE, TURN_CHANGES_IPC_CHANNELS.REMOVE_WORKTREE]) ipcMain.removeHandler(channel)
  })
}
