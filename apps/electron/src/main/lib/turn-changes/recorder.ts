import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import type { TurnChangeLimits, TurnChangeLimitation, TurnChangeOwner, TurnChangeRecord, TurnFileChange, TurnFileSnapshot } from '@proma/shared'
import { canonicalProjectPath } from '../project-mutation-guard'
import { captureTurnFile, collectTurnLimitations, validateTurnLimits } from './capture'
import type { CapturedTurnFile, TurnCaptureBudget } from './capture'
import { compareTurnFile } from './compare'
import { discoverTurnGitFiles } from './git'
import { canonicalTurnRoot, isWithinTurnRoot, normalizeTurnPath, turnPathKey, uniqueTurnPaths } from './paths'
import { sameTurnOwner, TurnChangeStore, validTurnOwner } from './store'

export interface BeginTurnChanges extends TurnChangeOwner {
  /** 由 main 根据会话授权解析；这个服务不接受 renderer 文件路径。 */
  cwd: string
  controlledPaths?: string[]
}

interface ActiveTurn {
  record: TurnChangeRecord
  before: Map<string, CapturedTurnFile>
  controlled: Set<string>
  budget: TurnCaptureBudget
  pending: Promise<void>
}

function ownerKey(owner: TurnChangeOwner): string { return JSON.stringify([owner.workspaceId, owner.sessionId, owner.turnId]) }
function copyOwner(owner: TurnChangeOwner): TurnChangeOwner { return { workspaceId: owner.workspaceId, sessionId: owner.sessionId, turnId: owner.turnId } }
function unavailable(): TurnFileSnapshot { return { availability: 'omitted', reason: 'not-captured' } }
function uniqueLimitations(items: TurnChangeLimitation[]): TurnChangeLimitation[] { return [...new Set(items)] }

export class TurnChangeRecorder {
  private readonly active = new Map<string, ActiveTurn>()
  private readonly reservations = new Set<string>()
  readonly store: TurnChangeStore
  readonly limits: TurnChangeLimits
  private readonly storageRoot: string

  constructor(storageRoot: string, limits: Partial<TurnChangeLimits> = {}) {
    this.storageRoot = resolve(storageRoot)
    this.store = new TurnChangeStore(storageRoot)
    this.limits = Object.freeze(validateTurnLimits(limits))
  }

  isRecordActive(id: string): boolean { return this.active.has(id) }

  get activeCount(): number { return this.reservations.size }

  async begin(input: BeginTurnChanges, signal?: AbortSignal): Promise<TurnChangeRecord> {
    if (!validTurnOwner(input)) throw new Error('无效的逐轮记录归属')
    signal?.throwIfAborted()
    const owner = copyOwner(input)
    const requestedCwd = input.cwd
    const requestedPaths = (input.controlledPaths ?? []).slice(0, this.limits.maxFiles + 1)
    const hasExcessPaths = (input.controlledPaths?.length ?? 0) > this.limits.maxFiles
    const key = ownerKey(owner)
    if (this.reservations.has(key)) throw new Error('本轮文件捕获已经开始')
    if (this.reservations.size >= 8) throw new Error('活跃逐轮捕获数量已达上限')
    this.reservations.add(key)
    const id = randomUUID()
    try {
      const cwd = await canonicalTurnRoot(requestedCwd)
      const storageRoot = canonicalProjectPath(this.storageRoot)
      if (isWithinTurnRoot(turnPathKey(cwd), turnPathKey(storageRoot))) throw new Error('逐轮私有快照必须存储在项目之外')
      const controlledPaths = requestedPaths.map(normalizeTurnPath)
      const controlled = new Set(controlledPaths.map(turnPathKey))
      const git = await discoverTurnGitFiles(cwd, this.limits, signal)
      const all = uniqueTurnPaths([...controlledPaths, ...git.paths])
      const notes: TurnChangeLimitation[] = [...git.limitations]
      if (hasExcessPaths || all.length > this.limits.maxFiles) notes.push('file-limit')
      const before = new Map<string, CapturedTurnFile>()
      const budget = { remainingBytes: this.limits.maxSnapshotBytes }
      for (const path of all.slice(0, this.limits.maxFiles)) before.set(path, await captureTurnFile(cwd, path, this.limits, budget, signal))
      notes.push(...collectTurnLimitations(before.values()))
      const record: TurnChangeRecord = {
        ...owner, schemaVersion: 1, recordId: id, canonicalCwd: cwd, startedAt: Date.now(), endedAt: null,
        completion: 'recording', partial: notes.length > 0,
        coverage: { mode: git.mode, externalWrites: git.mode === 'git-observed' ? 'observed' : 'not-observed' },
        limits: { ...this.limits }, limitations: uniqueLimitations(notes),
        files: [...before].map(([path, file]) => ({ path, before: file.snapshot, after: unavailable(), kind: 'unknown', source: controlled.has(turnPathKey(path)) ? 'controlled-tool' : 'git-observed' })),
      }
      signal?.throwIfAborted()
      await this.store.save(record, this.blobs(before))
      await this.store.index(record)
      signal?.throwIfAborted()
      for (const file of before.values()) delete file.bytes
      this.active.set(id, { record, before, controlled, budget, pending: Promise.resolve() })
      return structuredClone(record)
    } catch (error) {
      this.reservations.delete(key)
      await this.store.discardUnpublished(id, owner)
      throw error
    }
  }

  private blobs(files: ReadonlyMap<string, CapturedTurnFile>): Map<string, Buffer> {
    return new Map([...files.values()].flatMap(file => file.bytes && file.snapshot.hash ? [[file.snapshot.hash, file.bytes] as const] : []))
  }

  private queue<T>(owner: TurnChangeOwner, id: string, operation: (active: ActiveTurn) => Promise<T>): Promise<T> {
    const active = this.active.get(id)
    if (!active || !validTurnOwner(owner) || !sameTurnOwner(owner, active.record)) return Promise.reject(new Error('本轮捕获不存在或归属不匹配'))
    const task = active.pending.then(() => {
      if (this.active.get(id) !== active) throw new Error('本轮文件捕获已经结束')
      return operation(active)
    })
    active.pending = task.then(() => {}, () => {})
    return task
  }

  /** 必须在受控写入工具执行前调用；不会用工具执行后的内容冒充 before。 */
  captureBefore(owner: TurnChangeOwner, id: string, path: string, signal?: AbortSignal): Promise<void> {
    return this.queue(owner, id, async active => {
      signal?.throwIfAborted()
      const inputPath = normalizeTurnPath(path)
      const normalized = [...active.before.keys()].find(path => turnPathKey(path) === turnPathKey(inputPath)) ?? inputPath
      const before = new Map(active.before)
      const controlled = new Set(active.controlled)
      const budget = { ...active.budget }
      if (!before.has(normalized)) {
        if (before.size >= this.limits.maxFiles) {
          const record = { ...active.record, limitations: uniqueLimitations([...active.record.limitations, 'file-limit']), partial: true }
          await this.store.save(record, new Map())
          active.record = record
          return
        }
        const captured = await captureTurnFile(active.record.canonicalCwd, normalized, this.limits, budget, signal)
        before.set(normalized, captured)
      }
      controlled.add(turnPathKey(normalized))
      const notes = uniqueLimitations([...active.record.limitations, ...collectTurnLimitations(before.values())])
      const record: TurnChangeRecord = { ...active.record, files: [...before].map(([path, file]) => ({ path, before: file.snapshot, after: unavailable(), kind: 'unknown', source: controlled.has(turnPathKey(path)) ? 'controlled-tool' : 'git-observed' })), limitations: notes, partial: notes.length > 0 }
      await this.store.save(record, this.blobs(before))
      for (const file of before.values()) delete file.bytes
      active.before = before
      active.controlled = controlled
      active.budget = budget
      active.record = record
    })
  }

  finish(owner: TurnChangeOwner, id: string, completion: 'completed' | 'cancelled' | 'failed' = 'completed', signal?: AbortSignal): Promise<TurnChangeRecord> {
    if (!['completed', 'cancelled', 'failed'].includes(completion)) return Promise.reject(new Error('无效的逐轮完成状态'))
    return this.queue(owner, id, async active => {
      const after = new Map<string, CapturedTurnFile>()
      const notes = [...active.record.limitations]
      try {
        if (completion !== 'cancelled') {
          try {
            signal?.throwIfAborted()
            const git = active.record.coverage.mode === 'git-observed' ? await discoverTurnGitFiles(active.record.canonicalCwd, this.limits, signal) : undefined
            notes.push(...git?.limitations ?? [])
            if (git && git.mode !== 'git-observed') notes.push('git-unavailable')
            const all = uniqueTurnPaths([...active.before.keys(), ...git?.paths ?? []])
            if (all.length > this.limits.maxFiles) notes.push('file-limit')
            for (const path of all.slice(0, this.limits.maxFiles)) {
              // 轮初未列出的路径可能当时被忽略；不能把“未知”冒充“不存在”。
              if (!active.before.has(path)) active.before.set(path, { snapshot: unavailable() })
              after.set(path, await captureTurnFile(active.record.canonicalCwd, path, this.limits, active.budget, signal))
            }
            signal?.throwIfAborted()
          } catch {
            completion = signal?.aborted ? 'cancelled' : 'failed'
          }
        }
        const files: TurnFileChange[] = []
        for (const [path, before] of active.before) {
          const next = after.get(path)?.snapshot ?? unavailable()
          const change = compareTurnFile(path, before.snapshot, next, active.controlled.has(turnPathKey(path)) ? 'controlled-tool' : 'git-observed')
          if (change) files.push(change)
        }
        notes.push(...collectTurnLimitations(active.before.values()), ...collectTurnLimitations(after.values()), ...files.flatMap(file => file.after.reason ? [file.after.reason] : []))
        const record: TurnChangeRecord = {
          ...active.record, completion, endedAt: Math.max(Date.now(), active.record.startedAt),
          limitations: uniqueLimitations(notes), partial: notes.length > 0 || completion !== 'completed', files,
        }
        await this.store.save(record, this.blobs(after))
        return structuredClone(record)
      } finally {
        this.active.delete(id)
        this.reservations.delete(ownerKey(active.record))
      }
    })
  }

  noteLimitation(owner: TurnChangeOwner, id: string, reason: TurnChangeLimitation): Promise<void> {
    return this.queue(owner, id, async active => {
      const record = { ...active.record, partial: true, limitations: uniqueLimitations([...active.record.limitations, reason]) }
      await this.store.save(record, new Map())
      active.record = record
    })
  }
}
