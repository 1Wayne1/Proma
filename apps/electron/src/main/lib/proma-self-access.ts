export interface PromaSelfForegroundAccess {
  signal: AbortSignal
  isCurrent: () => boolean
}

interface VisibleSession {
  sessionId: string
  lifetime: AbortController
}

interface PromaSelfRunOrigin {
  sessionId: string
  trustedMainFrame: boolean
  triggeredBy?: string
  hasAutomationContext: boolean
}

/** 切出会话即撤销本次授权；重新切回只为之后的新运行授权。 */
export class PromaSelfForegroundSessions<T extends object> {
  private readonly visible = new WeakMap<T, VisibleSession>()

  get(target: T): string | undefined {
    return this.visible.get(target)?.sessionId
  }

  set(target: T, sessionId: string | null): void {
    const previous = this.visible.get(target)
    if (sessionId === previous?.sessionId) return
    previous?.lifetime.abort()
    if (sessionId === null) this.visible.delete(target)
    else this.visible.set(target, { sessionId, lifetime: new AbortController() })
  }

  grant(target: T, origin: PromaSelfRunOrigin, isTrustedWindow: () => boolean): PromaSelfForegroundAccess | undefined {
    const visible = this.visible.get(target)
    if (!origin.trustedMainFrame || origin.hasAutomationContext ||
        (origin.triggeredBy !== undefined && origin.triggeredBy !== 'user') ||
        !visible || visible.sessionId !== origin.sessionId || !isTrustedWindow()) return
    return {
      signal: visible.lifetime.signal,
      isCurrent: () => !visible.lifetime.signal.aborted && isTrustedWindow(),
    }
  }
}
