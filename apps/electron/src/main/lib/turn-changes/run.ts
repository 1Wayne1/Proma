import { isAbsolute, relative, resolve } from 'node:path'
import type { TurnChangeOwner, TurnChangeRecord } from '@proma/shared'
import { TurnChangeRecorder } from './recorder'
import { isWithinTurnRoot } from './paths'
import type { CanUseToolOptions, PermissionResult } from '../agent-permission-service'

type AuthorizeTool = (name: string, input: Record<string, unknown>, options: CanUseToolOptions) => Promise<PermissionResult>

export function withTurnChangesPermission(authorize: AuthorizeTool, run: () => TurnChangesRun | undefined, isCurrent: () => boolean): AuthorizeTool {
  return async (name, input, options) => {
    const permission = await authorize(name, input, options)
    if (permission.behavior === 'allow') {
      options.signal.throwIfAborted()
      if (!isCurrent()) throw new DOMException('本轮执行已结束', 'AbortError')
      await run()?.before(name, permission.updatedInput ?? input, options.signal)
      options.signal.throwIfAborted()
      if (!isCurrent()) throw new DOMException('本轮执行已结束', 'AbortError')
    }
    return permission
  }
}

export interface TurnChangesRunOptions {
  owner: TurnChangeOwner
  root: string
  toolCwd: string
  recorder: TurnChangeRecorder
  isCurrent: () => boolean
  onUnavailable?: () => void
  onChanged?: (owner: TurnChangeOwner) => void
  ready?: Promise<void>
}

/** 一个 runtime run 可接收追加消息；用户输入真正被 Pi 接纳后才切换采样轮次。 */
export class TurnChangesRun {
  private readonly controller = new AbortController()
  private readonly seen = new Set<string>()
  private current: TurnChangeRecord | undefined
  private pending: Promise<void>
  private closing: Promise<void> | undefined
  private sealed = false
  private unavailable = false

  constructor(private readonly options: TurnChangesRunOptions) { this.pending = options.ready ?? Promise.resolve() }

  abort(): void { this.controller.abort() }

  advance(turnId: string): Promise<void> {
    if (!turnId || turnId.length > 256 || this.sealed || this.seen.has(turnId)) return this.pending
    this.seen.add(turnId)
    const next = this.pending.then(async () => {
      if (this.controller.signal.aborted || !this.options.isCurrent() || this.unavailable) return
      await this.finishCurrent('completed')
      if (this.controller.signal.aborted || !this.options.isCurrent()) return
      this.current = await this.options.recorder.begin({ ...this.options.owner, turnId, cwd: this.options.root }, this.controller.signal)
      this.notifyChanged(this.current)
    })
    this.pending = next.catch(() => {
      if (!this.controller.signal.aborted) { this.unavailable = true; this.options.onUnavailable?.() }
    })
    return this.pending
  }

  async before(toolName: string, input: Record<string, unknown>, signal: AbortSignal): Promise<void> {
    const raw = toolName === 'NotebookEdit' ? input.notebook_path : input.file_path ?? input.path
    const target = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(toolName) && typeof raw === 'string'
      ? resolve(this.options.toolCwd, raw)
      : undefined
    await this.captureBeforeWrite(target, signal)
  }

  /** 已授权的主进程写入工具可提交验证后的绝对文件路径。 */
  async captureBeforeWrite(path: string | undefined, signal?: AbortSignal): Promise<void> {
    await this.pending
    signal?.throwIfAborted()
    this.controller.signal.throwIfAborted()
    if (!this.options.isCurrent()) throw new DOMException('本轮执行已结束', 'AbortError')
    if (!path || !isAbsolute(path) || !this.current || this.sealed) return
    const target = resolve(path)
    const root = [resolve(this.options.root), this.current.canonicalCwd].find(root => isWithinTurnRoot(root, target))
    try {
      if (!root) {
        await this.options.recorder.noteLimitation(this.current, this.current.recordId, 'additional-root-not-captured')
      } else {
        const combined = signal ? AbortSignal.any([signal, this.controller.signal]) : this.controller.signal
        await this.options.recorder.captureBefore(this.current, this.current.recordId, relative(root, target).replace(/\\/g, '/'), combined)
      }
    } catch {
      signal?.throwIfAborted()
      this.controller.signal.throwIfAborted()
      this.unavailable = true
      this.options.onUnavailable?.()
      if (this.current) await this.options.recorder.noteLimitation(this.current, this.current.recordId, 'not-captured').catch(() => {})
    }
    signal?.throwIfAborted()
    this.controller.signal.throwIfAborted()
  }

  private async finishCurrent(completion: 'completed' | 'cancelled' | 'failed'): Promise<void> {
    const current = this.current
    this.current = undefined
    if (!current) return
    const result = this.controller.signal.aborted || !this.options.isCurrent() ? 'cancelled' : completion
    await this.options.recorder.finish(current, current.recordId, result, this.controller.signal)
    this.notifyChanged(current)
  }

  private notifyChanged(owner: TurnChangeOwner): void {
    try { this.options.onChanged?.({ sessionId: owner.sessionId, workspaceId: owner.workspaceId, turnId: owner.turnId }) } catch { /* 展示订阅不能改变采样结果。 */ }
  }

  finish(completion: 'completed' | 'cancelled' | 'failed' = 'completed'): Promise<void> {
    if (!this.closing) {
      this.sealed = true
      this.closing = this.pending.then(() => this.finishCurrent(completion)).catch(() => { this.options.onUnavailable?.() })
    }
    return this.closing
  }
}
