import * as React from 'react'
import { atom, useAtom, useSetAtom, useStore } from 'jotai'
import { FileText } from 'lucide-react'
import type { PresentAction, PresentedResource, PresentTurn } from '@proma/shared'
import { Button } from '@/components/ui/button'
import { useMessageSessionId } from '@/components/ai-elements/message'
import { currentAgentSessionIdAtom, openWorkspaceComponentAtom } from '@/atoms/agent-atoms'
import { browserFocusRequestMapAtom, browserPanelMinimizedMapAtom, browserPanelOpenMapAtom, browserStateMapAtom } from '@/atoms/browser-atoms'
import { vaultPresentationAtomFamily } from '@/atoms/vault-atoms'
import { BROWSER_RISK_DISCLAIMER_VERSION } from '@/types/settings'

const statusText: Record<PresentedResource['status'], string> = {
  pending: '待打开', opening: '正在打开', presented: '已打开', cancelled: '已取消', unavailable: '文件已更改、移除或失去授权',
}

export function PresentedResources({ turnId }: { turnId?: string }): React.ReactElement | null {
  const sessionId = useMessageSessionId()
  return sessionId && turnId
    ? <PresentationCards key={JSON.stringify([sessionId, turnId])} sessionId={sessionId} turnId={turnId} />
    : null
}

function PresentationCards({ sessionId, turnId }: PresentTurn): React.ReactElement | null {
  const local = React.useMemo(() => atom({ resources: [] as PresentedResource[], error: '' }), [])
  const [state, setState] = useAtom(local)
  const owner = React.useMemo(() => ({ sessionId, turnId }), [sessionId, turnId])
  const store = useStore()
  const setVaultRequest = useSetAtom(vaultPresentationAtomFamily(sessionId))
  const openWorkspace = useSetAtom(openWorkspaceComponentAtom)
  const focusBrowser = useSetAtom(browserFocusRequestMapAtom)
  const minimizeBrowser = useSetAtom(browserPanelMinimizedMapAtom)
  const openBrowser = useSetAtom(browserPanelOpenMapAtom)
  const setBrowserState = useSetAtom(browserStateMapAtom)
  const current = React.useRef(true)
  const sequence = React.useRef(0)
  const [busy, setBusy] = useAtom(React.useMemo(() => atom<ReadonlySet<string>>(new Set<string>()), []))

  const refresh = React.useCallback(async (): Promise<void> => {
    if (!current.current) return
    const seq = ++sequence.current
    try {
      const resources = await window.electronAPI.listPresentedResources(owner)
      if (current.current && seq === sequence.current) setState(previous => ({ ...previous, resources }))
    } catch { /* 初始历史轮次可能来自旧会话；显式打开失败由操作结果提示。 */ }
  }, [owner, setState])

  React.useEffect(() => {
    current.current = true
    const stop = window.electronAPI.onPresentedResourcesChanged(turn => {
      if (turn.sessionId === sessionId && turn.turnId === turnId) void refresh()
    })
    void refresh()
    return () => { current.current = false; sequence.current += 1; stop() }
  }, [refresh, sessionId, turnId])

  const hasFiles = state.resources.length > 0
  React.useEffect(() => {
    if (!hasFiles) return
    const check = () => { if (!document.hidden) void refresh() }
    window.addEventListener('focus', check)
    const timer = window.setInterval(check, 5_000)
    return () => { window.removeEventListener('focus', check); window.clearInterval(timer) }
  }, [hasFiles, refresh])

  const showBrowserTab = (tabId: string): void => {
    if (store.get(currentAgentSessionIdAtom) !== sessionId) return
    minimizeBrowser(previous => { const next = new Map(previous); next.delete(sessionId); return next })
    openBrowser(previous => new Map(previous).set(sessionId, true))
    focusBrowser(previous => new Map(previous).set(sessionId, tabId))
  }

  const act = async (resource: PresentedResource, action: PresentAction['action']): Promise<void> => {
    setState(previous => ({ ...previous, error: '' }))
    if (action !== 'cancel') setBusy(previous => new Set(previous).add(resource.id))
    try {
      if (action === 'browser') {
        const settings = await window.electronAPI.getSettings()
        if ((settings.browserRiskDisclaimerVersion ?? 0) < BROWSER_RISK_DISCLAIMER_VERSION) {
          if (store.get(currentAgentSessionIdAtom) !== sessionId) return
          const browser = await window.electronAPI.openAgentBrowser(sessionId)
          setBrowserState(previous => new Map(previous).set(sessionId, browser))
          showBrowserTab(browser.activeTabId)
          setState(previous => ({ ...previous, error: '请确认受管浏览器提示，再点击在浏览器打开。' }))
          return
        }
      }
      const result = await window.electronAPI.actOnPresentedResource({ ...owner, resourceId: resource.id, action })
      if (result.vault) {
        if (!current.current || store.get(currentAgentSessionIdAtom) !== sessionId) {
          await window.electronAPI.finishVaultPresentation({ ...owner, requestId: result.vault.requestId, outcome: 'cancelled' })
        } else {
          setVaultRequest(result.vault)
          openWorkspace('vault')
        }
      }
      if (result.browserTabId) showBrowserTab(result.browserTabId)
    } catch (error) {
      if (current.current) setState(previous => ({ ...previous, error: error instanceof Error ? error.message : '无法展示交付文件' }))
    } finally {
      if (action !== 'cancel') setBusy(previous => { const next = new Set(previous); next.delete(resource.id); return next })
      void refresh()
    }
  }

  if (!hasFiles) return null
  return <section aria-label="本轮交付文件" className="mt-3 space-y-2 pl-[46px]">
    <h3 className="text-xs font-medium text-muted-foreground">本轮交付文件</h3>
    {state.resources.map(resource => {
      const opening = resource.status === 'opening'
      const disabled = resource.status === 'unavailable' || opening || busy.has(resource.id)
      return <article key={resource.id} className="rounded-md border border-border/70 bg-background/50 p-2.5">
        <div className="flex items-start gap-2">
          <FileText size={16} className="mt-0.5 shrink-0 text-muted-foreground" aria-hidden />
          <div className="min-w-0 flex-1">
            <div className="break-all text-sm font-medium">{resource.name}</div>
            <div className="text-xs text-muted-foreground">{resource.extension ? `${resource.extension.toUpperCase()} · ` : ''}{statusText[resource.status]}</div>
            {resource.description && <p className="mt-1 whitespace-pre-wrap break-words text-xs text-muted-foreground">{resource.description}</p>}
          </div>
        </div>
        <div className="mt-2 flex flex-wrap gap-1.5">
          <Button size="sm" variant="outline" disabled={disabled} onClick={() => void act(resource, 'open')}>打开预览</Button>
          {resource.vaultAvailable && <Button size="sm" variant="ghost" disabled={disabled} onClick={() => void act(resource, 'vault')}>在 Vault 打开</Button>}
          {resource.browserAvailable && <Button size="sm" variant="ghost" disabled={disabled} onClick={() => void act(resource, 'browser')}>在浏览器打开</Button>}
          <Button size="sm" variant="ghost" disabled={disabled} onClick={() => void act(resource, 'locate')}>定位文件</Button>
          {(opening || resource.status === 'pending') && <Button size="sm" variant="ghost" onClick={() => void act(resource, 'cancel')}>取消展示</Button>}
        </div>
      </article>
    })}
    {state.error && <p role="alert" className="text-xs text-destructive">{state.error}</p>}
  </section>
}
