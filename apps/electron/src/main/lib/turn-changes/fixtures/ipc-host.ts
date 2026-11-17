import { EventEmitter } from 'node:events'
import { writeFile } from 'node:fs/promises'
import assert from 'node:assert/strict'
import { AGENT_RUNTIME_METHODS, AGENT_RUNTIME_PROTOCOL_VERSION, createAgentRuntimeRequest } from '@proma/shared'
import type { AgentRuntimeEvent, AgentRuntimeRequest, TurnChangeOwner } from '@proma/shared'
import type { ElectronAPI } from '../../../../preload/index'

interface FakeEvent { sender: typeof sender; senderFrame: object }
type Handler = (event: FakeEvent, ...args: unknown[]) => unknown
const handlers = new Map<string, Handler>()
export const state: { configRoot: string; target: string; sessionAvailable: boolean; stopped: number } = { configRoot: '', target: '', sessionAvailable: true, stopped: 0 }
export const app = new EventEmitter()
export const ipcRenderer = Object.assign(new EventEmitter(), {
  invoke: async (channel: string, ...args: unknown[]): Promise<unknown> => invokeAs(channel, { sender, senderFrame: sender.mainFrame }, ...args),
})
export const sender = Object.assign(new EventEmitter(), { id: 1, mainFrame: {}, isDestroyed: () => false, send: (channel: string, owner: TurnChangeOwner): void => { ipcRenderer.emit(channel, {}, owner) } })
export const ipcMain = { handle: (channel: string, handler: Handler): void => { handlers.set(channel, handler) }, removeHandler: (channel: string): void => { handlers.delete(channel) } }
export async function invokeAs(channel: string, event: FakeEvent, ...args: unknown[]): Promise<unknown> {
  const handler = handlers.get(channel)
  if (!handler) throw new Error('handler not registered')
  return handler(event, ...args)
}
let api: ElectronAPI | undefined
export const contextBridge = { exposeInMainWorld: (_name: string, value: ElectronAPI): void => { api = value } }
export const webUtils = { getPathForFile: (): string => '' }
export function getApi(): ElectronAPI { if (!api) throw new Error('preload not exposed'); return api }
export const getMainWindow = (): { webContents: typeof sender } => ({ webContents: sender })
export const getAgentSessionMeta = (id: string) => id === 'fixture-session' && state.sessionAvailable ? { id, workspaceId: 'fixture-workspace' } : undefined
export const isAgentSessionDeleting = (): boolean => false
export const getAgentWorkspace = (id: string) => id === 'fixture-workspace' ? { id } : undefined
export function getConfigDir(): string { if (!state.configRoot) throw new Error('fixture config root missing'); return state.configRoot }

/** 仅替换 Electron utility host；实际 facade、授权包装器、记录服务与 preload 均执行原代码。 */
export class AgentRuntimeClient {
  private listener: ((event: AgentRuntimeEvent) => void) | undefined
  private handler: ((request: AgentRuntimeRequest) => Promise<unknown>) | undefined
  constructor(private readonly options: { sessionId: string }) {}
  setRequestHandler(handler: (request: AgentRuntimeRequest) => Promise<unknown>): void { this.handler = handler }
  onEvent(listener: (event: AgentRuntimeEvent) => void): () => void { this.listener = listener; return () => { this.listener = undefined } }
  async call(method: string, payload: { queryId: string; input?: Record<string, unknown> }): Promise<unknown> {
    if (method === AGENT_RUNTIME_METHODS.QUERY_START) {
      structuredClone(payload) // 新回调必须从跨进程 query input 中剥离。
      assert.equal(payload.input?.onUserTurnStarted, undefined)
      const emit = (method: string, data: unknown): void => this.listener?.({ kind: 'event', bootId: 'fixture', protocolVersion: AGENT_RUNTIME_PROTOCOL_VERSION, method, queryId: payload.queryId, sessionId: this.options.sessionId, payload: data })
      emit(AGENT_RUNTIME_METHODS.EVENT_QUERY_CALLBACK, { callback: 'user_turn_started', payload: { userMessageUuid: 'u2' } })
      const result = await this.handler?.(createAgentRuntimeRequest(AGENT_RUNTIME_METHODS.CAPABILITY_CAN_USE_TOOL, { queryId: payload.queryId, sessionId: this.options.sessionId, toolName: 'Write', input: { file_path: state.target }, options: { toolUseID: 'fixture-write' } }, { queryId: payload.queryId, sessionId: this.options.sessionId }))
      assert.equal((result as { behavior: string }).behavior, 'allow')
      await writeFile(state.target, 'written by fixture utility')
      emit(AGENT_RUNTIME_METHODS.EVENT_QUERY_END, {})
    }
    return { accepted: true, completed: true }
  }
  async stop(): Promise<void> { state.stopped += 1 }
}
