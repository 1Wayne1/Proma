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
  requests: Array<{ input: string; method?: string; credentials?: string; redirect?: string; hasHeaders: boolean }>
} = { destination: '', canceled: false, requests: [] }
export const dialog = {
  showSaveDialog: async (): Promise<{ canceled: boolean; filePath: string }> => {
    await state.duringDialog?.()
    return { canceled: state.canceled, filePath: state.destination }
  },
}
export const getMainWindow = (): { webContents: typeof sender } => ({ webContents: sender })
export const getChannelById = (id: string): { baseUrl: string } | undefined => id === 'fixture'
  ? { baseUrl: 'https://user:private-password@example.test/private?api_key=private-key' } : undefined
export const getEffectiveProxyUrl = async (): Promise<undefined> => undefined
export const createManagedProxyFetch = (): { fetch: NetworkFetch; close: () => Promise<void> } => ({
  fetch: async (input, init) => {
    state.requests.push({ input: String(input), method: init?.method, credentials: init?.credentials, redirect: init?.redirect, hasHeaders: init?.headers !== undefined })
    if (state.nextFetch) return state.nextFetch()
    return new Response(null, { status: 401 })
  },
  close: async () => {},
})
