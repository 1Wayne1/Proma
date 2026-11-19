import { app, dialog, ipcMain, session } from 'electron'
import type { IpcMainInvokeEvent } from 'electron'
import { NETWORK_IPC_CHANNELS } from '@proma/shared'
import type { NetworkDiagnosticExportResult } from '@proma/shared'
import { reconnectPiMcpNetworkConnections } from '../adapters/pi-mcp-tools'
import { browserController } from '../browser-controller'
import { getMainWindow } from '../main-window-store'
import { getChannelById } from '../channel-manager'
import { createManagedProxyFetch } from '../proxy-fetch'
import { getEffectiveProxyUrl, invalidateSystemProxyCache } from '../proxy-settings-service'
import { writeTextFileAtomic } from '../safe-file'
import { NetworkDiagnosticPreviews } from './network-diagnostics'
import { checkNetworkOrigin, getNetworkProbeOrigin, networkMonitor } from './network-monitor'
import { NetworkReconnectCoordinator } from './network-reconnect'
import { waitForNetworkOperation, withNetworkAbortSignal } from './network-recovery'

function assertOwner(event: IpcMainInvokeEvent): void {
  const main = getMainWindow()
  if (!main || main.webContents !== event.sender || event.senderFrame !== event.sender.mainFrame) throw new Error('仅主窗口可以访问网络诊断')
}

export function registerNetworkIpcHandlers(): void {
  const previews = new NetworkDiagnosticPreviews()
  const reconnector = new NetworkReconnectCoordinator({
    monitor: networkMonitor,
    refreshProxy: async (signal) => {
      invalidateSystemProxyCache()
      await waitForNetworkOperation(getEffectiveProxyUrl(), signal)
    },
    reloadBrowserSessions: async () => {
      await session.defaultSession.forceReloadProxyConfig()
      await session.defaultSession.clearHostResolverCache().catch(() => {})
      await browserController.refreshNetworkSessions()
    },
    reconnectMcp: async (signal) => {
      await waitForNetworkOperation(reconnectPiMcpNetworkConnections(), signal)
    },
    timeoutMs: 5_000,
  })
  let checking: { owner: number; requestId: string; controller: AbortController } | undefined
  const handlers = Object.values(NETWORK_IPC_CHANNELS).filter(channel => channel !== NETWORK_IPC_CHANNELS.STATUS_CHANGED)
  const unsubscribe = networkMonitor.subscribe(snapshot => {
    const window = getMainWindow()
    if (window && !window.webContents.isDestroyed()) window.webContents.send(NETWORK_IPC_CHANNELS.STATUS_CHANGED, snapshot)
  })

  ipcMain.handle(NETWORK_IPC_CHANNELS.GET_STATUS, event => { assertOwner(event); return networkMonitor.snapshot() })
  ipcMain.handle(NETWORK_IPC_CHANNELS.NOTIFY_ONLINE, (event, online: unknown) => {
    assertOwner(event)
    if (typeof online !== 'boolean') throw new Error('无效的联网提示')
    return networkMonitor.notifyOnline(online)
  })
  ipcMain.handle(NETWORK_IPC_CHANNELS.CANCEL_CHECK, (event, requestId: unknown) => {
    assertOwner(event)
    if (checking?.owner === event.sender.id && checking.requestId === requestId) checking.controller.abort()
  })
  ipcMain.handle(NETWORK_IPC_CHANNELS.RECONNECT, async (event, input?: unknown) => {
    assertOwner(event)
    let requestId: string | undefined
    if (input !== undefined) {
      if (!input || typeof input !== 'object' || Array.isArray(input)) {
        throw new Error('无效的网络重连请求')
      }
      const rawRequestId = (input as Record<string, unknown>).requestId
      if (rawRequestId !== undefined) {
        if (typeof rawRequestId !== 'string' || !/^[\w-]{1,80}$/.test(rawRequestId)) {
          throw new Error('无效的网络重连请求')
        }
        requestId = rawRequestId
      }
    }
    const ownerController = new AbortController()
    const onDestroyed = (): void => ownerController.abort()
    event.sender.once('destroyed', onDestroyed)
    try {
      return await reconnector.reconnect(event.sender.id, requestId, ownerController.signal)
    } finally {
      event.sender.removeListener('destroyed', onDestroyed)
    }
  })
  ipcMain.handle(NETWORK_IPC_CHANNELS.CANCEL_RECONNECT, (event, requestId?: unknown) => {
    assertOwner(event)
    if (requestId !== undefined && (typeof requestId !== 'string' || !/^[\w-]{1,80}$/.test(requestId))) {
      throw new Error('无效的网络重连取消请求')
    }
    reconnector.cancel(event.sender.id, requestId)
  })
  ipcMain.handle(NETWORK_IPC_CHANNELS.CHECK, async (event, input: unknown) => {
    assertOwner(event)
    if (!input || typeof input !== 'object') throw new Error('无效的渠道检查请求')
    const { requestId, channelId } = input as Record<string, unknown>
    if (typeof requestId !== 'string' || !/^[\w-]{1,80}$/.test(requestId) || typeof channelId !== 'string' || channelId.length > 128) throw new Error('无效的渠道检查请求')
    let baseUrl: string
    try {
      const channel = getChannelById(channelId)
      if (!channel) throw new Error('not found')
      baseUrl = getNetworkProbeOrigin(channel.baseUrl)
    } catch { throw new Error('该渠道没有可检查的 HTTP 服务地址') }
    checking?.controller.abort()
    const current = { owner: event.sender.id, requestId, controller: new AbortController() }
    checking = current
    const onDestroyed = (): void => current.controller.abort()
    event.sender.once('destroyed', onDestroyed)
    try {
      return await withNetworkAbortSignal([current.controller.signal, AbortSignal.timeout(4000)], async signal => {
        const proxy = await waitForNetworkOperation(getEffectiveProxyUrl(), signal)
        const managed = createManagedProxyFetch(proxy, false)
        try { return await checkNetworkOrigin(baseUrl, managed.fetch, signal) } finally { await managed.close() }
      })
    } finally {
      event.sender.removeListener('destroyed', onDestroyed)
      if (checking === current) checking = undefined
    }
  })
  ipcMain.handle(NETWORK_IPC_CHANNELS.PREVIEW_DIAGNOSTICS, event => {
    assertOwner(event)
    return previews.create(event.sender.id, networkMonitor.snapshot())
  })
  ipcMain.handle(NETWORK_IPC_CHANNELS.EXPORT_DIAGNOSTICS, async (event, previewId: unknown): Promise<NetworkDiagnosticExportResult> => {
    assertOwner(event)
    const preview = previews.read(event.sender.id, previewId)
    const main = getMainWindow()!
    const destination = await dialog.showSaveDialog(main, {
      title: '导出已预览的网络诊断', defaultPath: 'proma-network-diagnostics.json',
      filters: [{ name: 'JSON', extensions: ['json'] }],
    })
    if (destination.canceled || !destination.filePath) return { status: 'cancelled' }
    assertOwner(event)
    // 弹窗等待期间可能过期或被新预览替代；不得导出未确认的新报告。
    previews.read(event.sender.id, previewId)
    writeTextFileAtomic(destination.filePath, JSON.stringify(preview.report, null, 2))
    return { status: 'saved' }
  })
  app.once('before-quit', () => {
    checking?.controller.abort()
    reconnector.cancelAll()
    unsubscribe()
    previews.clear()
    for (const handler of handlers) ipcMain.removeHandler(handler)
  })
}
