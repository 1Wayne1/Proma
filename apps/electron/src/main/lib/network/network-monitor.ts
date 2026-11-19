import { createHash } from 'node:crypto'
import type {
  NetworkEndpointStatus,
  NetworkFailureKind,
  NetworkReconnectStatus,
  NetworkSource,
  NetworkStatusSnapshot,
} from '@proma/shared'
import { classifyNetworkFailure } from './network-errors'
import { throwIfNetworkOperationAborted, waitForNetworkOperation } from './network-recovery'

interface Observation {
  id: string
  generation: number
}

export interface ReconnectToken {
  generation: number
  epoch: number
}

/** 仅依赖可调用签名，不要求 Bun 专有的 fetch.preconnect 扩展。 */
export interface NetworkFetch {
  (...args: Parameters<typeof globalThis.fetch>): ReturnType<typeof globalThis.fetch>
}

/** 只留白名单状态；原始 URL、错误、响应头和正文均不进入诊断记录。 */
export class NetworkMonitor {
  private revision = 0
  private generation = 0
  private reconnectEpoch = 0
  private reconnectGeneration = 0
  private reconnectStatus?: NetworkReconnectStatus
  private onlineHint: boolean | null = null
  private readonly entries = new Map<string, { generation: number; status: NetworkEndpointStatus }>()
  private readonly listeners = new Set<(snapshot: NetworkStatusSnapshot) => void>()

  constructor(private readonly now: () => number = Date.now) {}

  snapshot(): NetworkStatusSnapshot {
    return {
      revision: this.revision,
      onlineHint: this.onlineHint,
      endpoints: [...this.entries.values()].map(entry => ({ ...entry.status })),
      ...(this.reconnectStatus ? { reconnect: { ...this.reconnectStatus } } : {}),
    }
  }

  subscribe(listener: (snapshot: NetworkStatusSnapshot) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private publish(): void {
    this.revision += 1
    for (const listener of this.listeners) {
      try { listener(this.snapshot()) } catch { /* 界面订阅异常不能改变网络请求结果。 */ }
    }
  }

  notifyOnline(value: boolean): NetworkStatusSnapshot {
    if (this.onlineHint !== value) { this.onlineHint = value; this.publish() }
    return this.snapshot()
  }

  begin(source: NetworkSource, identity: string): Observation {
    const id = createHash('sha256').update(`${source}:${identity}`).digest('hex').slice(0, 24)
    const generation = ++this.generation
    this.entries.delete(id)
    this.entries.set(id, { generation, status: { id, source, state: 'checking', updatedAt: this.now() } })
    while (this.entries.size > 32) this.entries.delete(this.entries.keys().next().value!)
    this.publish()
    return { id, generation }
  }

  finish(observation: Observation, result: Pick<NetworkEndpointStatus, 'state' | 'failureKind' | 'httpStatus'>): void {
    const entry = this.entries.get(observation.id)
    if (!entry || entry.generation !== observation.generation) return
    const failureKind = result.failureKind ?? (result.state === 'closed' ? entry.status.failureKind : undefined)
    entry.status = {
      id: entry.status.id, source: entry.status.source, state: result.state, updatedAt: this.now(),
      ...(failureKind === undefined ? {} : { failureKind }),
      ...(result.httpStatus === undefined ? {} : { httpStatus: result.httpStatus }),
    }
    this.publish()
  }

  beginReconnect(): ReconnectToken {
    const generation = ++this.reconnectGeneration
    this.reconnectStatus = { epoch: this.reconnectEpoch, state: 'reconnecting', updatedAt: this.now() }
    this.publish()
    return { generation, epoch: this.reconnectEpoch }
  }

  finishReconnect(
    token: ReconnectToken,
    result: { state: 'ready' | 'failed' | 'cancelled'; failureKind?: NetworkFailureKind },
  ): NetworkStatusSnapshot {
    if (token.generation !== this.reconnectGeneration) return this.snapshot()
    if (result.state === 'ready') this.reconnectEpoch += 1
    this.reconnectStatus = {
      epoch: this.reconnectEpoch,
      state: result.state,
      updatedAt: this.now(),
      ...(result.failureKind === undefined ? {} : { failureKind: result.failureKind }),
    }
    this.publish()
    return this.snapshot()
  }
}

export const networkMonitor = new NetworkMonitor()

/** 去掉认证、路径、查询和片段后检查 origin；不跟随重定向。 */
export function getNetworkProbeOrigin(raw: string): string {
  const url = new URL(raw)
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('仅支持 HTTP 或 HTTPS 渠道地址')
  return url.origin
}

function getRequestOrigin(input: Parameters<typeof globalThis.fetch>[0]): string | undefined {
  try { return getNetworkProbeOrigin(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url) } catch { return undefined }
}

/** 保留请求及 Response 原对象，不消费流、不重试、不改变认证或代理。 */
export function createObservedFetch(
  fetcher: NetworkFetch,
  monitor = networkMonitor,
): typeof globalThis.fetch {
  return (async (input, init) => {
    const origin = getRequestOrigin(input)
    const observation = origin ? monitor.begin('http', origin) : undefined
    try {
      const response = await fetcher(input, init)
      if (observation) monitor.finish(observation, { state: 'reachable', httpStatus: response.status })
      return response
    } catch (error) {
      if (observation) {
        const failure = classifyNetworkFailure(error, init?.signal ?? undefined)
        monitor.finish(observation, { state: failure.kind === 'cancelled' ? 'cancelled' : 'failed', failureKind: failure.kind })
      }
      throw error
    }
  }) as typeof globalThis.fetch
}

export async function checkNetworkOrigin(
  origin: string,
  fetcher: NetworkFetch,
  signal: AbortSignal,
  monitor = networkMonitor,
): Promise<NetworkStatusSnapshot> {
  const target = getNetworkProbeOrigin(origin)
  throwIfNetworkOperationAborted(signal)
  const observation = monitor.begin('probe', target)
  try {
    const response = await waitForNetworkOperation(fetcher(target, {
      method: 'HEAD', redirect: 'manual', credentials: 'omit', signal,
    }), signal)
    await response.body?.cancel()
    monitor.finish(observation, { state: 'reachable', httpStatus: response.status })
  } catch (error) {
    const failure = classifyNetworkFailure(error, signal)
    monitor.finish(observation, { state: failure.kind === 'cancelled' ? 'cancelled' : 'failed', failureKind: failure.kind })
  }
  return monitor.snapshot()
}
