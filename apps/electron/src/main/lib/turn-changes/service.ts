import { projectPathsOverlap } from '../project-mutation-guard'
import { join } from 'node:path'
import type { TurnChangeOwner } from '@proma/shared'
import { getConfigDir } from '../config-paths'
import { TurnChangeRecorder } from './recorder'
import { TurnChangesRun } from './run'
import type { TurnChangesRunOptions } from './run'

interface RegisteredRun { sessionId: string; generation: number; run: TurnChangesRun; root: string }
let recorder: TurnChangeRecorder | undefined
const runs = new Set<RegisteredRun>()
const listeners = new Set<(owner: TurnChangeOwner) => void>()
export function subscribeTurnChanges(listener: (owner: TurnChangeOwner) => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function getTurnChangeRecorder(): TurnChangeRecorder {
  recorder ??= new TurnChangeRecorder(join(getConfigDir(), 'turn-changes'))
  return recorder
}

export function createTurnChangesRun(options: Omit<TurnChangesRunOptions, 'recorder' | 'ready' | 'onChanged'>, generation: number): TurnChangesRun {
  // 只有仍拥有 active slot 的新 run 可以收束旧代次；迟到的旧预检不能碰新 run。
  const previous = options.isCurrent() ? [...runs].filter(entry => entry.sessionId === options.owner.sessionId && entry.generation !== generation) : []
  for (const entry of previous) entry.run.abort()
  const ready = previous.length ? waitForTurnChanges(Promise.all(previous.map(entry => finishTurnChangesRun(entry.run, 'cancelled')))) : Promise.resolve()
  const run = new TurnChangesRun({ ...options, ready, recorder: getTurnChangeRecorder(), onChanged: owner => {
    for (const listener of listeners) { try { listener(owner) } catch { /* 窗口可能正在关闭。 */ } }
  } })
  runs.add({ sessionId: options.owner.sessionId, generation, run, root: options.root })
  return run
}

export async function finishTurnChangesRun(run: TurnChangesRun, completion: 'completed' | 'cancelled' | 'failed'): Promise<void> {
  await run.finish(completion)
  for (const entry of runs) if (entry.run === run) runs.delete(entry)
}

export function abortSessionTurnChanges(sessionId: string, generation?: number): TurnChangesRun[] {
  const selected = [...runs].filter(entry => entry.sessionId === sessionId && (generation === undefined || entry.generation === generation))
  for (const entry of selected) entry.run.abort()
  return selected.map(entry => entry.run)
}

export function abortAllTurnChanges(): void { for (const entry of runs) entry.run.abort() }
export function hasActiveTurnChanges(): boolean { return runs.size > 0 }
export async function drainTurnChanges(): Promise<void> {
  const pending = Promise.all([...runs].map(entry => finishTurnChangesRun(entry.run, 'cancelled')))
  await waitForTurnChanges(pending)
}
async function waitForTurnChanges(pending: Promise<unknown>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try { await Promise.race([pending, new Promise<void>(resolve => { timer = setTimeout(resolve, 5000) })]) }
  finally { clearTimeout(timer) }
}

export async function listTurnChanges(owner: TurnChangeOwner) { return getTurnChangeRecorder().store.list(owner) }


/** 启动及每小时清理：单轮保留最近 10 次，已完成记录最长保留 30 天。 */
export function startTurnChangesMaintenance(liveSessions: () => ReadonlySet<string>): () => void {
  let pending = false
  let stopped = false
  const clean = async (): Promise<void> => {
    if (pending || stopped) return
    pending = true
    try {
      const result = await getTurnChangeRecorder().store.cleanup({ isSessionLive: id => liveSessions().has(id), isRecordActive: id => getTurnChangeRecorder().isRecordActive(id) })
      if (result.partial || result.skipped) console.warn('[逐轮快照清理] 部分记录保留待复核:', result)
    } catch (error) { console.warn('[逐轮快照清理] 未完成:', error) }
    finally { pending = false }
  }
  void clean()
  const timer = setInterval(() => { void clean() }, 60 * 60 * 1000)
  timer.unref()
  return () => { stopped = true; clearInterval(timer) }
}

export function hasTurnChangesInProject(root: string): boolean { return [...runs].some(entry => projectPathsOverlap(root, entry.root)) }
