import { app, ipcMain } from 'electron'
import { AGENT_MEMORY_IPC_CHANNEL } from '@proma/shared'
import { AgentMemoryService } from './agent-memory'
import { executeMemoryAction, parseAgentMemoryRequest } from './agent-memory-actions'
import { getMainWindow } from './main-window-store'

export function registerAgentMemoryIpc(service = new AgentMemoryService()): void {
  ipcMain.handle(AGENT_MEMORY_IPC_CHANNEL, (event, input: unknown) => {
    if (getMainWindow()?.webContents !== event.sender || !event.senderFrame || event.sender.mainFrame !== event.senderFrame) {
      throw new Error('仅 Proma 主窗口可以管理记忆')
    }
    const request = parseAgentMemoryRequest(input)
    if (request.action === 'target') return service.resolveTarget(request.scope)
    return executeMemoryAction(service, request.target, request, { source: 'user', permissionMode: 'bypassPermissions' })
  })
  app.once('will-quit', () => ipcMain.removeHandler(AGENT_MEMORY_IPC_CHANNEL))
}
