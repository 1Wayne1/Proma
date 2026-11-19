import { EventEmitter } from 'node:events'
import type { ElectronAPI } from '../../../../preload/index'
import type { NetworkFetch } from '../network-monitor'

interface FakeEvent {
  sender: typeof sender
  senderFrame: object
}
type Handler = (event: FakeEvent, ...args: unknown[]) => unknown
const handlers = new Map<string, Handler>()
export const app = new EventEmitter()
export const ipcRenderer = Object.assign(new EventEmitter(), {
  invoke: async (channel: string, ...args: unknown[]): Promise<unknown> => invokeAs(channel, { sender, senderFrame: sender.mainFrame }, ...args),
})
export const sender = Object.assign(new EventEmitter(), {
  id: 1, mainFrame: {}, isDestroyed: () => false,
  send: (channel: string, value: unknown): void => { ipcRenderer.emit(channel, {}, value) },
})
export const ipcMain = {
  handle: (channel: string, handler: Handler): void => { handlers.set(channel, handler) },
  removeHandler: (channel: string): void => { handlers.delete(channel) },
}
export async function invokeAs(channel: string, event: FakeEvent, ...args: unknown[]): Promise<unknown> {
  const handler = handlers.get(channel)
  if (!handler) throw new Error('handler not registered')
  return handler(event, ...args)
}
let api: ElectronAPI | undefined
export const contextBridge = { exposeInMainWorld: (_name: string, value: ElectronAPI): void => { api = value } }
export const webUtils = { getPathForFile: (): string => '' }
export function getApi(): ElectronAPI { if (!api) throw new Error('preload not exposed'); return api }
export const state: {
  destination: string
  canceled: boolean
  duringDialog?: () => Promise<void>
  nextFetch?: () => Promise<Response>
  nextReconnectProxy?: () => Promise<void>
  requests: Array<{ input: string; method?: string; credentials?: string; redirect?: string; hasHeaders: boolean }>
  reconnectCalls: {
    invalidateProxy: number
    getProxy: number
    defaultProxyReload: number
    defaultDnsClear: number
    browserRefresh: number
    mcpReconnect: number
  }
} = {
  destination: '',
  canceled: false,
  requests: [],
  reconnectCalls: {
    invalidateProxy: 0,
    getProxy: 0,
    defaultProxyReload: 0,
    defaultDnsClear: 0,
    browserRefresh: 0,
    mcpReconnect: 0,
  },
}
export const session = {
  defaultSession: {
    forceReloadProxyConfig: async (): Promise<void> => {
      state.reconnectCalls.defaultProxyReload += 1
    },
    clearHostResolverCache: async (): Promise<void> => {
      state.reconnectCalls.defaultDnsClear += 1
    },
  },
}
export const dialog = {
  showSaveDialog: async (): Promise<{ canceled: boolean; filePath: string }> => {
    await state.duringDialog?.()
    return { canceled: state.canceled, filePath: state.destination }
  },
}
export const getMainWindow = (): { webContents: typeof sender } => ({ webContents: sender })
export const getChannelById = (id: string): { baseUrl: string } | undefined => id === 'fixture'
  ? { baseUrl: 'https://user:private-password@example.test/private?api_key=private-key' } : undefined
export const invalidateSystemProxyCache = (): void => {
  state.reconnectCalls.invalidateProxy += 1
}
export const getEffectiveProxyUrl = async (): Promise<undefined> => {
  if (state.nextReconnectProxy) {
    state.reconnectCalls.getProxy += 1
    await state.nextReconnectProxy()
  }
  return undefined
}
export const browserController = {
  refreshNetworkSessions: async (): Promise<void> => {
    state.reconnectCalls.browserRefresh += 1
  },
}
export const reconnectPiMcpNetworkConnections = async (): Promise<{ closedIdle: number; retiredActive: number; clearedCooldowns: number }> => {
  state.reconnectCalls.mcpReconnect += 1
  return { closedIdle: 0, retiredActive: 0, clearedCooldowns: 0 }
}
export const createManagedProxyFetch = (): { fetch: NetworkFetch; close: () => Promise<void> } => ({
  fetch: async (input, init) => {
    state.requests.push({ input: String(input), method: init?.method, credentials: init?.credentials, redirect: init?.redirect, hasHeaders: init?.headers !== undefined })
    if (state.nextFetch) return state.nextFetch()
    return new Response(null, { status: 401 })
  },
  close: async () => {},
})
