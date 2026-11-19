import type { NetworkFailureKind, NetworkStatusSnapshot } from '@proma/shared'
import { classifyNetworkFailure } from './network-errors'
import { networkMonitor, type NetworkMonitor, type ReconnectToken } from './network-monitor'
import { throwIfNetworkOperationAborted, waitForNetworkOperation, withNetworkAbortSignal } from './network-recovery'

export interface NetworkReconnectDependencies {
  monitor?: NetworkMonitor
  refreshProxy: (signal: AbortSignal) => Promise<void>
  reloadBrowserSessions: (signal: AbortSignal) => Promise<void>
  reconnectMcp: (signal: AbortSignal) => Promise<void>
  timeoutMs?: number
}

interface ReconnectWaiter {
  owner: number
  requestId?: string
  resolve: (snapshot: NetworkStatusSnapshot) => void
  reject: (reason: unknown) => void
  cleanupOwnerSignal: () => void
}

interface ReconnectRun {
  token: ReconnectToken
  controller: AbortController
  waiters: Set<ReconnectWaiter>
  settled: boolean
}

const DEFAULT_RECONNECT_TIMEOUT_MS = 5_000

function toAbortError(reason?: unknown): Error {
  if (reason instanceof Error) return reason
  return new DOMException('网络重连已取消', 'AbortError')
}

function runStep(step: (signal: AbortSignal) => Promise<void>, signal: AbortSignal): Promise<void> {
  const promise = Promise.resolve().then(() => step(signal))
  // 取消或超时后底层若迟到拒绝，不能泄漏未捕获的 Promise rejection。
  promise.catch(() => {})
  return promise
}

/**
 * 协调显式网络重连：合并并发请求，刷新代理缓存、浏览器会话与空闲网络 MCP，
 * 不中断活跃任务、不重放有副作用调用、不访问云端服务。
 */
export class NetworkReconnectCoordinator {
  private readonly monitor: NetworkMonitor
  private readonly timeoutMs: number
  private inFlight?: ReconnectRun

  constructor(private readonly deps: NetworkReconnectDependencies) {
    this.monitor = deps.monitor ?? networkMonitor
    const timeoutMs = deps.timeoutMs ?? DEFAULT_RECONNECT_TIMEOUT_MS
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new RangeError('timeoutMs 必须为正数')
    }
    this.timeoutMs = timeoutMs
  }

  async reconnect(owner: number, requestId?: string, ownerSignal?: AbortSignal): Promise<NetworkStatusSnapshot> {
    throwIfNetworkOperationAborted(ownerSignal)

    const run = this.inFlight ?? this.startRun()
    return new Promise<NetworkStatusSnapshot>((resolve, reject) => {
      const waiter: ReconnectWaiter = {
        owner,
        requestId,
        resolve,
        reject,
        cleanupOwnerSignal: () => {},
      }
      if (ownerSignal) {
        const onAbort = (): void => {
          this.removeWaiterByOwnerAbort(run, waiter, toAbortError(ownerSignal.reason))
        }
        ownerSignal.addEventListener('abort', onAbort, { once: true })
        waiter.cleanupOwnerSignal = () => ownerSignal.removeEventListener('abort', onAbort)
      }
      run.waiters.add(waiter)
    })
  }

  cancel(owner: number, requestId?: string): boolean {
    const run = this.inFlight
    if (!run || run.settled) return false

    const matched: ReconnectWaiter[] = []
    for (const waiter of run.waiters) {
      if (waiter.owner === owner && (requestId === undefined || waiter.requestId === requestId)) {
        matched.push(waiter)
      }
    }
    if (matched.length === 0) return false

    if (matched.length === run.waiters.size) {
      run.controller.abort(toAbortError())
      this.settleRun(run, { state: 'cancelled', failureKind: 'cancelled' })
      return true
    }

    const abortError = toAbortError()
    for (const waiter of matched) {
      run.waiters.delete(waiter)
      waiter.cleanupOwnerSignal()
      waiter.reject(abortError)
    }
    return true
  }

  cancelAll(): void {
    const run = this.inFlight
    if (!run || run.settled) return
    run.controller.abort(toAbortError())
    this.settleRun(run, { state: 'cancelled', failureKind: 'cancelled' })
  }

  private removeWaiterByOwnerAbort(run: ReconnectRun, waiter: ReconnectWaiter, reason: Error): void {
    if (run.settled || !run.waiters.has(waiter)) return
    run.waiters.delete(waiter)
    waiter.cleanupOwnerSignal()
    waiter.reject(reason)
    if (run.waiters.size === 0) {
      run.controller.abort(reason)
      this.settleRun(run, { state: 'cancelled', failureKind: 'cancelled' })
    }
  }

  private startRun(): ReconnectRun {
    const token = this.monitor.beginReconnect()
    const run: ReconnectRun = {
      token,
      controller: new AbortController(),
      waiters: new Set(),
      settled: false,
    }
    this.inFlight = run

    void this.executeRun(run)
    return run
  }

  private async executeRun(run: ReconnectRun): Promise<void> {
    const timeoutSignal = AbortSignal.timeout(this.timeoutMs)
    try {
      await withNetworkAbortSignal([run.controller.signal, timeoutSignal], async (signal) => {
        await waitForNetworkOperation(
          Promise.all([
            runStep(this.deps.refreshProxy, signal),
            runStep(this.deps.reloadBrowserSessions, signal),
            runStep(this.deps.reconnectMcp, signal),
          ]),
          signal,
        )
      })
      this.settleRun(run, { state: 'ready' })
    } catch (error) {
      if (run.controller.signal.aborted && !timeoutSignal.aborted) {
        this.settleRun(run, { state: 'cancelled', failureKind: 'cancelled' })
        return
      }
      const failure = classifyNetworkFailure(error, timeoutSignal.aborted ? timeoutSignal : run.controller.signal)
      this.settleRun(run, {
        state: failure.kind === 'cancelled' ? 'cancelled' : 'failed',
        failureKind: failure.kind,
      })
    }
  }

  private settleRun(
    run: ReconnectRun,
    result: { state: 'ready' | 'failed' | 'cancelled'; failureKind?: NetworkFailureKind },
  ): void {
    if (run.settled) return
    run.settled = true
    if (this.inFlight === run) this.inFlight = undefined

    const snapshot = this.monitor.finishReconnect(run.token, result)
    const waiters = [...run.waiters]
    run.waiters.clear()
    for (const waiter of waiters) {
      waiter.cleanupOwnerSignal()
      waiter.resolve(snapshot)
    }
  }
}
