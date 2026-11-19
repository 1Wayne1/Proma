import { EventEmitter } from 'node:events'
import type { ElectronAPI } from '../../../preload/index'

interface FakeFrame {
  id?: string
}

interface FakeSender {
  id: number
  mainFrame: FakeFrame
}

interface FakeEvent {
  sender: FakeSender
  senderFrame: FakeFrame
}

type Handler = (event: FakeEvent, ...args: unknown[]) => unknown

const handlers = new Map<string, Handler>()
export const app = new EventEmitter()

export const mainFrame: FakeFrame = { id: 'main-frame' }
export const subFrame: FakeFrame = { id: 'sub-frame' }
export const sender: FakeSender = { id: 1, mainFrame }
export const foreignSender: FakeSender = { id: 2, mainFrame: { id: 'foreign-frame' } }

export const ipcMain = {
  handle: (channel: string, handler: Handler): void => {
    handlers.set(channel, handler)
  },
  removeHandler: (channel: string): void => {
    handlers.delete(channel)
  },
}

export async function invokeAs(channel: string, event: FakeEvent, ...args: unknown[]): Promise<unknown> {
  const handler = handlers.get(channel)
  if (!handler) throw new Error('handler not registered')
  return handler(event, ...args)
}

export const ipcRenderer = Object.assign(new EventEmitter(), {
  invoke: async (channel: string, ...args: unknown[]): Promise<unknown> =>
    invokeAs(channel, { sender, senderFrame: sender.mainFrame }, ...args),
})

let exposedApi: ElectronAPI | undefined
export const contextBridge = {
  exposeInMainWorld: (_name: string, value: ElectronAPI): void => {
    exposedApi = value
  },
}
export const webUtils = { getPathForFile: (): string => '' }

export function getApi(): ElectronAPI {
  if (!exposedApi) throw new Error('preload not exposed')
  return exposedApi
}

export const state: { mainWindow: { webContents: FakeSender } | null } = {
  mainWindow: { webContents: sender },
}

export const getMainWindow = (): { webContents: FakeSender } | null => state.mainWindow
