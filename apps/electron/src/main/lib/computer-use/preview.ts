import { randomUUID } from 'node:crypto'
import type { DesktopPreviewCommand, DesktopPreviewFrame, DesktopPreviewState } from '@proma/shared'

export interface PreviewSource {
  capture(signal: AbortSignal, lowFrequency: boolean): Promise<string>
  activate(signal: AbortSignal): Promise<void>
  close(): void
}
interface Entry {
  state: DesktopPreviewState
  source: PreviewSource
  lifetime: AbortController
  isCurrent: () => boolean
  detach: () => void
  idle?: ReturnType<typeof setTimeout>
  working?: Promise<unknown>
  nextFrame: number
}

/** Renderer 消费完才拉下一帧。主进程不缓存 PNG，也不向订阅者广播像素。 */
export class DesktopPreviewRegistry {
  private readonly entries = new Map<string, Entry>()
  constructor(private readonly changed: (sessionId: string) => void) {}

  bind(sessionId: string, title: string, source: PreviewSource, signal: AbortSignal, isCurrent: () => boolean): () => void {
    this.drop(sessionId)
    signal.throwIfAborted()
    const entry: Entry = { state: { sessionId, id: randomUUID(), title, mode: 'live' }, source, lifetime: new AbortController(),
      isCurrent, detach: () => signal.removeEventListener('abort', dispose), nextFrame: 0 }
    const dispose = () => { if (this.entries.get(sessionId) === entry) this.drop(sessionId) }
    this.entries.set(sessionId, entry)
    signal.addEventListener('abort', dispose, { once: true })
    this.keepAlive(entry)
    this.changed(sessionId)
    return dispose
  }

  closeAll() {
    for (const sessionId of this.entries.keys()) this.drop(sessionId)
  }

  private keepAlive(entry: Entry) {
    clearTimeout(entry.idle)
    entry.idle = setTimeout(() => this.drop(entry.state.sessionId), entry.state.error ? 120_000 : 30_000)
    entry.idle.unref()
  }

  private drop(sessionId: string) {
    const entry = this.entries.get(sessionId)
    if (!entry) return
    this.entries.delete(sessionId)
    clearTimeout(entry.idle)
    entry.detach()
    entry.lifetime.abort()
    entry.source.close()
    this.changed(sessionId)
  }

  state(sessionId: string): DesktopPreviewState | null {
    const entry = this.entries.get(sessionId)
    if (!entry) return null
    if (!entry.isCurrent()) { this.drop(sessionId); return null }
    return { ...entry.state }
  }

  async command({ sessionId, id, action }: DesktopPreviewCommand): Promise<DesktopPreviewFrame | null> {
    if (this.state(sessionId)?.id !== id) return null
    const entry = this.entries.get(sessionId)!
    if (action === 'stop') { this.drop(sessionId); return null }
    this.keepAlive(entry)
    if (action === 'activate' && entry.working) await entry.working.catch(() => {})
    if (this.state(sessionId)?.id !== id || entry.working) return null
    if (action === 'retry') {
      entry.state.error = undefined
      entry.nextFrame = 0
      this.changed(sessionId)
      return null
    }
    if (entry.state.error || (action === 'frame' && Date.now() < entry.nextFrame)) return null
    const started = Date.now()
    const low = entry.state.mode === 'snapshot'
    const run = async (): Promise<DesktopPreviewFrame | null> => {
      if (action === 'activate') { await entry.source.activate(entry.lifetime.signal); return null }
      const png = await entry.source.capture(entry.lifetime.signal, low)
      if (this.state(sessionId)?.id !== id) return null
      if (!low && Date.now() - started > 1200) { entry.state.mode = 'snapshot'; this.changed(sessionId) }
      const delayMs = entry.state.mode === 'live' ? 250 : 2000
      entry.nextFrame = Date.now() + delayMs
      return { id, png, delayMs }
    }
    const operation = run()
    entry.working = operation
    try { return await operation } catch (error) {
      if (this.state(sessionId)?.id !== id) return null
      entry.source.close()
      if (action === 'frame' && !low) { entry.state.mode = 'snapshot'; entry.nextFrame = Date.now() + 1500 }
      else entry.state.error = error instanceof Error ? error.message : '窗口预览失败'
      this.keepAlive(entry)
      this.changed(sessionId)
      return null
    } finally { entry.working = undefined }
  }
}
