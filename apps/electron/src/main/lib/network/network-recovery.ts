import { classifyNetworkFailure } from './network-errors'

export interface NetworkRecoveryOptions {
  /** 默认不重放有副作用或结果未知的操作。 */
  replay: 'read-only' | 'never'
  signal?: AbortSignal
  maxAttempts?: number
  baseDelayMs?: number
  maxDelayMs?: number
}

export function throwIfNetworkOperationAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new DOMException('网络操作已取消', 'AbortError')
}

/** 显式解绑来源信号，避免长生命周期连接持有已结束请求的监听器。 */
export async function withNetworkAbortSignal<T>(
  signals: Array<AbortSignal | undefined>,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController()
  const cleanups: Array<() => void> = []
  try {
    for (const source of signals) {
      if (!source) continue
      const abort = (): void => {
        if (!controller.signal.aborted) controller.abort(source.reason)
      }
      if (source.aborted) abort()
      else {
        source.addEventListener('abort', abort, { once: true })
        cleanups.push(() => source.removeEventListener('abort', abort))
      }
    }
    throwIfNetworkOperationAborted(controller.signal)
    return await operation(controller.signal)
  } finally {
    for (const cleanup of cleanups) cleanup()
  }
}

/** 取消某个等待者，不取消被其他会话共享的握手；迟到结果只由连接缓存处理。 */
export function waitForNetworkOperation<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      signal?.removeEventListener('abort', onAbort)
      reject(signal?.reason ?? new DOMException('网络操作已取消', 'AbortError'))
    }
    operation.then(value => {
      signal?.removeEventListener('abort', onAbort)
      if (signal?.aborted) onAbort()
      else resolve(value)
    }, error => {
      signal?.removeEventListener('abort', onAbort)
      reject(error)
    })
    if (signal?.aborted) onAbort()
    else signal?.addEventListener('abort', onAbort, { once: true })
  })
}

export function waitForNetworkRecovery(delayMs: number, signal?: AbortSignal): Promise<void> {
  throwIfNetworkOperationAborted(signal)
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      reject(signal?.reason ?? new DOMException('网络操作已取消', 'AbortError'))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, delayMs)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** 只负责有限的只读请求恢复；不包装整个 Agent loop 或自动重放工具。 */
export async function runWithNetworkRecovery<T>(
  operation: (attempt: number) => Promise<T>,
  options: NetworkRecoveryOptions,
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? 3
  const baseDelayMs = options.baseDelayMs ?? 250
  const maxDelayMs = options.maxDelayMs ?? 4000
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 8) throw new RangeError('maxAttempts 必须为 1—8 的整数')
  if (![baseDelayMs, maxDelayMs].every(value => Number.isFinite(value) && value >= 0 && value <= 60_000)) throw new RangeError('重试延迟必须为 0—60000 毫秒')

  for (let attempt = 1; ; attempt += 1) {
    throwIfNetworkOperationAborted(options.signal)
    try {
      const result = await operation(attempt)
      // 调用方忽略 signal 后迟到的成功不能继续流入后续操作。
      throwIfNetworkOperationAborted(options.signal)
      return result
    } catch (error) {
      throwIfNetworkOperationAborted(options.signal)
      if (options.replay === 'never' || attempt >= maxAttempts || !classifyNetworkFailure(error, options.signal).retryable) throw error
      await waitForNetworkRecovery(Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1)), options.signal)
    }
  }
}
