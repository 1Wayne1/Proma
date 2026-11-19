import { isWithinTurnRoot } from './turn-changes/paths'
import { assertNoProjectMutation, canonicalProjectPath, projectPathsOverlap } from './project-mutation-guard'
import { randomUUID } from 'node:crypto'
import {
  TERMINAL_IPC_CHANNELS,
  type AgentTerminalActivity,
  type AgentTerminalCatalog,
  type AgentTerminalCloseEvent,
  type AgentTerminalOpenEvent,
  assertTerminalProfileSupported,
  parseTerminalProfile,
  type TerminalCreateInput,
  type TerminalInput,
  type TerminalOutputAck,
  type TerminalProfile,
  type TerminalResizeInput,
  type TerminalSnapshot,
  type TerminalState,
} from '@proma/shared'
import { getMainWindow } from './main-window-store'
import {
  appendTerminalOutput,
  readTerminalOutput,
  type TerminalOutputBuffer,
  type TerminalOutputReadOptions,
  type TerminalOutputReadResult,
} from './terminal-output-buffer'
import { resolveAgentTerminalCwd } from './terminal-agent-policy'
import { requireTerminalCwd, resolveTerminalCwd } from './terminal-cwd'
import { terminalRuntimeClient } from './terminal-runtime-client'
import { readTerminalProcessParents } from './terminal-agent-activity'

const terminals = new Map<string, TerminalState>()
const pendingTerminals = new Map<string, Promise<TerminalState>>()
const cancelledPendingTerminalIds = new Set<string>()
const terminalSessionOwners = new Map<string, string>()
const terminalCwds = new Map<string, string>()
const terminalOutputBuffers = new Map<string, TerminalOutputBuffer>()
const agentTerminals = new Map<string, AgentTerminalRecord>()
const exitedAgentTerminalStates = new Map<string, TerminalState>()
const MAX_REPLAY_CHARS = 1_000_000
let initialized = false
let activityTimer: ReturnType<typeof setTimeout> | undefined
let activityProbe: AbortController | undefined

export interface AgentTerminalRecord {
  sessionId: string
  terminalId: string
  title: string
  cwd: string
  profile: TerminalProfile
  status: 'running' | 'exited'
  exitCode?: number
  retained: boolean
  active: boolean
  previewAt: number
}

function getAgentTerminalActivity(sessionId: string): AgentTerminalActivity {
  const records = getAgentTerminalList(sessionId)
  const preview = records.filter(record => record.status === 'running')
    .sort((left, right) => right.previewAt - left.previewAt)[0]
  return {
    sessionId,
    terminalIds: records.filter(record => record.active).map(record => record.terminalId),
    ...(preview ? { preview: { terminalId: preview.terminalId, at: preview.previewAt } } : {}),
  }
}

function notifyAgentTerminalActivity(sessionId: string): void {
  getMainWindow()?.webContents.send(TERMINAL_IPC_CHANNELS.AGENT_ACTIVITY, getAgentTerminalActivity(sessionId))
}

function scheduleAgentTerminalActivity(): void {
  if (![...agentTerminals.values()].some(record => record.status === 'running')) {
    clearTimeout(activityTimer)
    activityTimer = undefined
    activityProbe?.abort()
    return
  }
  if (activityTimer || activityProbe) return
  activityTimer = setTimeout(() => {
    activityTimer = undefined
    void refreshAgentTerminalActivity()
  }, process.platform === 'win32' ? 4_000 : 1_000)
  activityTimer.unref()
}

async function refreshAgentTerminalActivity(): Promise<void> {
  const probe = activityProbe = new AbortController()
  try {
    const owners = [...agentTerminals.values()].flatMap(record => {
      const state = terminals.get(record.terminalId)
      return state ? [{ record, state }] : []
    })
    const parents = await readTerminalProcessParents(probe.signal).catch(() => new Set<number>())
    if (probe.signal.aborted) return
    const changed = new Set<string>()
    for (const { record, state } of owners) {
      if (terminals.get(record.terminalId) !== state || agentTerminals.get(record.terminalId) !== record) continue
      const active = parents.has(state.pid)
      if (record.active !== active) {
        record.active = active
        changed.add(record.sessionId)
      }
    }
    for (const sessionId of changed) notifyAgentTerminalActivity(sessionId)
  } finally {
    activityProbe = undefined
    scheduleAgentTerminalActivity()
  }
}

function initialize(): void {
  if (initialized) return
  initialized = true
  terminalRuntimeClient.onOutput((event) => {
    if (!terminals.has(event.terminalId) && !pendingTerminals.has(event.terminalId)) return
    appendOutputBuffer(event)
    // 主进程已接收并缓冲，隐藏标签页也必须推进流控，避免退出事件滞留。
    terminalRuntimeClient.acknowledgeOutput(event)
    getMainWindow()?.webContents.send(TERMINAL_IPC_CHANNELS.OUTPUT, event)
  })
  terminalRuntimeClient.onExit((event) => {
    const state = terminals.get(event.terminalId)
    if (!state) return
    terminals.delete(event.terminalId)
    terminalCwds.delete(event.terminalId)
    const agentTerminal = agentTerminals.get(event.terminalId)
    if (agentTerminal) {
      // Agent 可在命令退出后读取结果；缓冲会随显式关闭或会话回收一并释放。
      agentTerminal.status = 'exited'
      agentTerminal.exitCode = event.exitCode
      agentTerminal.active = false
      exitedAgentTerminalStates.set(event.terminalId, state)
      notifyAgentTerminalActivity(agentTerminal.sessionId)
      scheduleAgentTerminalActivity()
      const priorExited = getAgentTerminalList(agentTerminal.sessionId).filter(record => record !== agentTerminal && record.status === 'exited' && !record.retained)
      for (const record of priorExited.slice(0, -7)) closeAgentTerminal(record.sessionId, record.terminalId)
    } else {
      terminalSessionOwners.delete(event.terminalId)
      terminalOutputBuffers.delete(event.terminalId)
    }
    getMainWindow()?.webContents.send(TERMINAL_IPC_CHANNELS.EXIT, event)
  })
}

export async function createTerminal(
  input: TerminalCreateInput,
  options: { strictCwd?: boolean } = {},
): Promise<TerminalState> {
  initialize()
  validateTerminalId(input.terminalId)
  const existing = terminals.get(input.terminalId)
  const pending = pendingTerminals.get(input.terminalId)
  if (existing || pending || agentTerminals.has(input.terminalId)) {
    if (terminalSessionOwners.get(input.terminalId) !== input.sessionId) throw new Error('终端不属于当前会话')
    if (existing) return existing
    if (pending) return pending
    throw new Error('Agent 终端已退出')
  }
  const cwd = options.strictCwd ? requireTerminalCwd(input.cwd) : resolveTerminalCwd(input.cwd)

  assertNoProjectMutation([cwd])
  terminalCwds.set(input.terminalId, cwd)

  // Record ownership before spawning so a concurrent session deletion can cancel it.
  terminalSessionOwners.set(input.terminalId, input.sessionId)
  // Initialize the replay buffer before the runtime can emit the first shell output.
  terminalOutputBuffers.set(input.terminalId, { output: '', sequence: 0, startOffset: 0, endOffset: 0 })
  const creation = terminalRuntimeClient.create({
    ...input,
    cwd,
    cols: normalizeDimension(input.cols),
    rows: normalizeDimension(input.rows),
  }, options).then((state) => {
    if (cancelledPendingTerminalIds.delete(state.terminalId)) {
      terminalRuntimeClient.kill(state.terminalId)
      throw new Error('终端已在创建完成前关闭')
    }
    terminals.set(state.terminalId, state)
    return state
  })
  pendingTerminals.set(input.terminalId, creation)
  void creation.then(
    () => pendingTerminals.delete(input.terminalId),
    () => {
      pendingTerminals.delete(input.terminalId)
      cancelledPendingTerminalIds.delete(input.terminalId)
      terminalSessionOwners.delete(input.terminalId)
      terminalCwds.delete(input.terminalId)
      terminalOutputBuffers.delete(input.terminalId)
    },
  )
  return creation
}

export async function writeTerminal(input: TerminalInput): Promise<void> {
  initialize()
  validateTerminalId(input.terminalId)
  if (typeof input.data !== 'string' || input.data.length > 64 * 1024) throw new Error('终端输入无效或过长')
  if (!terminals.has(input.terminalId)) throw new Error('终端不存在')
  await terminalRuntimeClient.input(input)
}

export async function resizeTerminal(input: TerminalResizeInput): Promise<void> {
  initialize()
  validateTerminalId(input.terminalId)
  if (!terminals.has(input.terminalId)) return
  await terminalRuntimeClient.resize({
    terminalId: input.terminalId,
    cols: normalizeDimension(input.cols),
    rows: normalizeDimension(input.rows),
  })
}

export function killTerminal(terminalId: string): void {
  validateTerminalId(terminalId)
  if (pendingTerminals.has(terminalId)) cancelledPendingTerminalIds.add(terminalId)
  terminals.delete(terminalId)
  terminalSessionOwners.delete(terminalId)
  terminalCwds.delete(terminalId)
  terminalOutputBuffers.delete(terminalId)
  exitedAgentTerminalStates.delete(terminalId)
  const record = agentTerminals.get(terminalId)
  agentTerminals.delete(terminalId)
  terminalRuntimeClient.kill(terminalId)
  if (record) {
    const event: AgentTerminalCloseEvent = { sessionId: record.sessionId, terminalId }
    getMainWindow()?.webContents.send(TERMINAL_IPC_CHANNELS.AGENT_CLOSE, event)
    notifyAgentTerminalActivity(record.sessionId)
    scheduleAgentTerminalActivity()
  }
}

/** 为 Agent 创建其会话归属的可见终端，目录仍受现有文件授权范围限制；profile 决定交互 shell。 */
export async function openAgentTerminal(input: {
  sessionId: string
  cwd?: string
  title?: string
  profile?: unknown
  /** 仅用于未显式指定的 Windows 历史 profile；创建失败时安全回退到 default。 */
  fallbackToDefaultProfile?: boolean
  agentCwd?: string
  allowedRoots?: string[]
}): Promise<AgentTerminalRecord> {
  const cwd = resolveAgentTerminalCwd(input)
  const profile = assertTerminalProfileSupported(parseTerminalProfile(input.profile), process.platform)
  const terminalId = randomUUID()
  const title = input.title?.trim().slice(0, 80) || 'Agent 终端'
  let resolvedProfile = profile
  try {
    await createTerminal({ terminalId, sessionId: input.sessionId, cwd, profile: resolvedProfile, cols: 80, rows: 24 }, { strictCwd: true })
  } catch (error) {
    if (!input.fallbackToDefaultProfile || profile === 'default') throw error
    resolvedProfile = 'default'
    await createTerminal({ terminalId, sessionId: input.sessionId, cwd, profile: resolvedProfile, cols: 80, rows: 24 }, { strictCwd: true })
  }
  if (!terminals.has(terminalId) || terminalSessionOwners.get(terminalId) !== input.sessionId) {
    throw new Error('终端已退出或会话已关闭')
  }
  const record: AgentTerminalRecord = { sessionId: input.sessionId, terminalId, title, cwd, profile: resolvedProfile, status: 'running', retained: false, active: false, previewAt: Date.now() }
  agentTerminals.set(terminalId, record)
  notifyAgentTerminalOpen(record)
  notifyAgentTerminalActivity(record.sessionId)
  scheduleAgentTerminalActivity()
  return record
}

/**
 * 直接向 Agent 所属终端写入一条完整命令。该动作由 Pi 既有 permission mode 保护，
 * 不会读取或回传终端正文；用户始终能在右侧可见终端中中断它。
 */
export async function executeAgentTerminal(input: {
  sessionId: string
  command: string
  /** 指定时复用当前 Agent 会话中仍在运行的可见 PTY；省略时创建新终端。 */
  terminalId?: string
  /** 仅在创建新终端时生效；复用已有终端时必须与其 profile 一致。 */
  profile?: unknown
  /** 仅在新建终端且使用 Windows 历史 profile 时生效。 */
  fallbackToDefaultProfile?: boolean
  cwd?: string
  title?: string
  agentCwd?: string
  allowedRoots?: string[]
}): Promise<AgentTerminalRecord> {
  const command = input.command.trim()
  if (!command || command.length > 64 * 1024) throw new Error('终端命令为空或过长')
  const profile = assertTerminalProfileSupported(parseTerminalProfile(input.profile), process.platform)
  const profileWasSpecified = input.profile !== undefined && input.profile !== null && input.profile !== ''

  const requestedTerminalId = input.terminalId?.trim()
  if (requestedTerminalId) {
    const record = getOwnedAgentTerminal(input.sessionId, requestedTerminalId)
    if (record.status !== 'running') throw new Error('终端已退出，不能复用')
    if (profileWasSpecified && record.profile !== profile) {
      throw new Error(`终端 ${requestedTerminalId} 运行在 ${record.profile}，不能以 ${profile} 复用；请省略 terminalId 另开新终端`)
    }
    await writeTerminal({ terminalId: record.terminalId, data: `${command}\r` })
    record.previewAt = Date.now()
    notifyAgentTerminalActivity(record.sessionId)
    return record
  }

  const title = input.title?.trim() || `Agent · ${command.replace(/\s+/g, ' ').slice(0, 48)}`
  const record = await openAgentTerminal({ ...input, profile, title })
  await writeTerminal({ terminalId: record.terminalId, data: `${command}\r` })
  return record
}

function getAgentTerminalList(sessionId: string): AgentTerminalRecord[] {
  return [...agentTerminals.values()].filter((record) => record.sessionId === sessionId)
}

export function listAgentTerminals(sessionId: string): AgentTerminalRecord[] {
  return getAgentTerminalList(sessionId).map(record => ({ ...record }))
}

export function getAgentTerminalCatalog(): AgentTerminalCatalog {
  const terminals = [...agentTerminals.values()].map(({ sessionId, terminalId, title, cwd, profile }) => ({ sessionId, terminalId, title, cwd, profile }))
  const sessions = new Set(terminals.map(terminal => terminal.sessionId))
  return { terminals, activity: Array.from(sessions, getAgentTerminalActivity) }
}

export function retainAgentTerminal(sessionId: string, terminalId: string): void {
  getOwnedAgentTerminal(sessionId, terminalId).retained = true
}

export function readFloatingTerminalPreview(sessionId: string, terminalId: string, startedAt: number): string | null {
  const record = agentTerminals.get(terminalId)
  if (record?.sessionId !== sessionId || record.status !== 'running' || record.previewAt < startedAt) return null
  const buffer = terminalOutputBuffers.get(terminalId)
  return buffer ? readTerminalOutput(buffer, { limit: 1_500 }).output : null
}

/** 读取当前 Agent 会话拥有的终端输出；只暴露有限内存回放缓冲，不读取其他会话或系统终端。 */
export function readAgentTerminalOutput(
  sessionId: string,
  terminalId: string,
  options: TerminalOutputReadOptions = {},
): { terminal: AgentTerminalRecord; read: TerminalOutputReadResult } {
  const terminal = getOwnedAgentTerminal(sessionId, terminalId)
  const buffer = terminalOutputBuffers.get(terminalId)
  if (!buffer) throw new Error('终端输出已不可用')
  return { terminal, read: readTerminalOutput(buffer, options) }
}

export async function interruptAgentTerminal(sessionId: string, terminalId: string): Promise<void> {
  const record = getOwnedAgentTerminal(sessionId, terminalId)
  if (record.status !== 'running') return
  await writeTerminal({ terminalId, data: '\u0003' })
}

export function closeAgentTerminal(sessionId: string, terminalId: string): void {
  getOwnedAgentTerminal(sessionId, terminalId)
  killTerminal(terminalId)
}

/** 终止并回收指定 Agent 会话的全部交互和 Agent 执行终端。 */
export function closeTerminalsForSession(sessionId: string): void {
  for (const [terminalId, ownerSessionId] of terminalSessionOwners) {
    if (ownerSessionId === sessionId) killTerminal(terminalId)
  }
}

export function getTerminalSnapshot(terminalId: string): TerminalSnapshot {
  validateTerminalId(terminalId)
  const state = terminals.get(terminalId) ?? exitedAgentTerminalStates.get(terminalId)
  if (!state) throw new Error('终端不存在')
  const buffer = terminalOutputBuffers.get(terminalId) ?? { output: '', sequence: 0, startOffset: 0, endOffset: 0 }
  return { state, ...buffer, exitCode: agentTerminals.get(terminalId)?.exitCode }
}

export function acknowledgeTerminalOutput(input: TerminalOutputAck): void {
  validateTerminalId(input.terminalId)
  if (!Number.isSafeInteger(input.sequence) || input.sequence < 1) throw new Error('终端输出序号无效')
  if (!terminals.has(input.terminalId)) return
  terminalRuntimeClient.acknowledgeOutput(input)
}

export async function stopAllTerminals(): Promise<void> {
  terminals.clear()
  pendingTerminals.clear()
  cancelledPendingTerminalIds.clear()
  terminalSessionOwners.clear()
  terminalCwds.clear()
  terminalOutputBuffers.clear()
  agentTerminals.clear()
  exitedAgentTerminalStates.clear()
  scheduleAgentTerminalActivity()
  await terminalRuntimeClient.stop()
}

function notifyAgentTerminalOpen(record: AgentTerminalRecord): void {
  const event: AgentTerminalOpenEvent = {
    sessionId: record.sessionId,
    terminalId: record.terminalId,
    title: record.title,
    cwd: record.cwd,
    profile: record.profile,
  }
  getMainWindow()?.webContents.send(TERMINAL_IPC_CHANNELS.AGENT_OPEN, event)
}

function getOwnedAgentTerminal(sessionId: string, terminalId: string): AgentTerminalRecord {
  validateTerminalId(terminalId)
  const record = agentTerminals.get(terminalId)
  if (!record || record.sessionId !== sessionId) throw new Error('终端不存在或不属于当前 Agent 会话')
  return record
}

function appendOutputBuffer(event: { terminalId: string; sequence: number; data: string }): void {
  const current = terminalOutputBuffers.get(event.terminalId) ?? { output: '', sequence: 0, startOffset: 0, endOffset: 0 }
  terminalOutputBuffers.set(event.terminalId, appendTerminalOutput(current, event, MAX_REPLAY_CHARS))
}

function validateTerminalId(terminalId: string): void {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(terminalId)) throw new Error('终端 ID 无效')
}

function normalizeDimension(value: number): number {
  return Number.isFinite(value) ? Math.max(1, Math.min(500, Math.floor(value))) : 1
}


/** 包括尚未完成创建的终端；终端退出后不再占用项目操作边界。 */
export function hasTerminalsInProject(root: string): boolean {
  return [...terminalCwds.values()].some(cwd => projectPathsOverlap(root, cwd))
}

export function releaseExitedTerminalsInProject(root: string): void {
  for (const terminal of [...agentTerminals.values()]) {
    if (terminal.status === 'exited' && isWithinTurnRoot(canonicalProjectPath(root), canonicalProjectPath(terminal.cwd))) closeAgentTerminal(terminal.sessionId, terminal.terminalId)
  }
}
