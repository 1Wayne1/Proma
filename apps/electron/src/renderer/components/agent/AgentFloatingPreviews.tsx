import * as React from 'react'
import { atom, useAtomValue, useStore } from 'jotai'
import { selectAtom } from 'jotai/utils'
import { ArrowUpRight, Globe2, GripHorizontal, SquareTerminal, X } from 'lucide-react'
import type { AgentFloatingPreviewRequest } from '@proma/shared'
import {
  agentDiffPanelTabAtom,
  agentSessionStreamingStateAtomFamily,
  agentSidePanelOpenAtomFamily,
  agentSidePanelSplitMapAtom,
  agentTerminalPreviewAtom,
  agentTerminalTabsAtom,
  currentAgentSessionIdAtom,
  getBrowserSidePanelTab,
  getTerminalSidePanelTab,
} from '@/atoms/agent-atoms'
import { browserPanelMinimizedMapAtom, browserPanelOpenMapAtom, browserStateMapAtom } from '@/atoms/browser-atoms'
import { Button } from '@/components/ui/button'
import { clampFloatingPreviewPosition, shouldShowFloatingPreview } from './floating-preview-policy'

type PreviewKind = AgentFloatingPreviewRequest['kind']

interface PreviewTarget {
  kind: PreviewKind
  targetId: string
  title: string
}

interface Point { x: number; y: number }

const dismissedPreviewsAtom = atom(new Map<string, { runGeneration: number; kinds: PreviewKind[] }>())
const previewNames = { browser: '浏览器', terminal: '终端' }
const CARD_HEIGHT = 166

function clampPosition(card: HTMLElement, point: Point): Point {
  const container = card.parentElement
  if (!container) return point
  return clampFloatingPreviewPosition(point, { x: container.clientWidth - card.offsetWidth, y: container.clientHeight - card.offsetHeight })
}

function FloatingPreviewCard({ sessionId, runGeneration, target, index, onHide, onOpen }: {
  sessionId: string
  runGeneration: number
  target: PreviewTarget
  index: number
  onHide: () => void
  onOpen: (takeOver: boolean) => Promise<void>
}): React.ReactElement {
  const { kind, targetId, title } = target
  const name = previewNames[kind]
  const Icon = kind === 'browser' ? Globe2 : SquareTerminal
  const cardRef = React.useRef<HTMLElement>(null)
  const drag = React.useRef<{ pointer: Point; position: Point } | null>(null)
  const [position, setPosition] = React.useState<Point | null>(null)
  const [frame, setFrame] = React.useState<string | null>(null)
  const [opening, setOpening] = React.useState(false)
  const [error, setError] = React.useState('')

  React.useEffect(() => {
    let disposed = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const pull = async (): Promise<void> => {
      if (document.visibilityState === 'visible') {
        try {
          const next = await window.electronAPI.getAgentFloatingPreview({ sessionId, runGeneration, kind, targetId })
          if (!disposed) setFrame(next)
        } catch {
          if (!disposed) setFrame(null)
        }
      }
      if (!disposed) timer = setTimeout(() => void pull(), kind === 'browser' ? 1000 : 450)
    }
    void pull()
    return () => { disposed = true; clearTimeout(timer) }
  }, [kind, runGeneration, sessionId, targetId])

  React.useEffect(() => {
    const card = cardRef.current
    if (!card?.parentElement) return
    const observer = new ResizeObserver(() => setPosition(previous => previous && clampPosition(card, previous)))
    observer.observe(card.parentElement)
    return () => observer.disconnect()
  }, [])

  const open = async (takeOver: boolean): Promise<void> => {
    if (opening) return
    setOpening(true)
    setError('')
    try { await onOpen(takeOver) }
    catch (error) { setError(error instanceof Error ? error.message : '无法打开完整界面') }
    finally { setOpening(false) }
  }

  return (
    <section ref={cardRef} aria-label={`${name}浮动预览`}
      className="titlebar-no-drag pointer-events-auto absolute flex w-60 max-w-[calc(100%-1rem)] flex-col overflow-hidden rounded-lg border border-border bg-card text-card-foreground shadow-lg"
      style={position ? { left: position.x, top: position.y } : { right: 12, top: `min(${12 + index * (CARD_HEIGHT + 8)}px, max(0px, 100% - ${CARD_HEIGHT}px))` }}>
      <div className="flex h-8 items-center gap-1 border-b px-1">
        <Button type="button" variant="ghost" size="icon" className="size-7 cursor-grab touch-none active:cursor-grabbing"
          aria-label={`拖动${name}预览`} title="拖动或使用方向键移动"
          onPointerDown={(event) => {
            const card = cardRef.current
            if (!card || event.button !== 0) return
            drag.current = { pointer: { x: event.clientX, y: event.clientY }, position: { x: card.offsetLeft, y: card.offsetTop } }
            event.currentTarget.setPointerCapture(event.pointerId)
          }}
          onPointerMove={(event) => {
            const card = cardRef.current
            const start = drag.current
            if (card && start) setPosition(clampPosition(card, {
              x: start.position.x + event.clientX - start.pointer.x,
              y: start.position.y + event.clientY - start.pointer.y,
            }))
          }}
          onLostPointerCapture={() => { drag.current = null }}
          onKeyDown={(event) => {
            const card = cardRef.current
            if (!card || !['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key)) return
            event.preventDefault()
            const dx = event.key === 'ArrowLeft' ? -16 : event.key === 'ArrowRight' ? 16 : 0
            const dy = event.key === 'ArrowUp' ? -16 : event.key === 'ArrowDown' ? 16 : 0
            setPosition(clampPosition(card, { x: card.offsetLeft + dx, y: card.offsetTop + dy }))
          }}><GripHorizontal className="size-4" /></Button>
        <Icon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-xs font-medium" title={title}>{title}</span>
        <Button type="button" variant="ghost" size="icon" className="size-7" aria-label={`本轮隐藏${name}预览`} onClick={onHide}><X className="size-3.5" /></Button>
      </div>
      <button type="button" aria-label={`打开完整${name}`} disabled={opening} onClick={() => void open(false)}
        className="flex h-[100px] w-full min-w-0 items-center justify-center overflow-hidden bg-muted/45 text-left text-xs text-muted-foreground hover:bg-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring">
        {kind === 'browser' && frame ? <img draggable={false} src={`data:image/jpeg;base64,${frame}`} alt="当前网页缩略图" className="size-full object-contain" />
          : frame ? <pre className="max-h-full w-full overflow-hidden whitespace-pre px-2 font-mono text-[10px] leading-4 text-foreground">{frame.trimEnd().split('\n').slice(-5).join('\n')}</pre>
          : kind === 'browser' ? '等待网页画面' : '等待终端输出'}
      </button>
      <div className="flex h-8 items-center justify-end gap-1 px-1">
        <Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-xs" disabled={opening} onClick={() => void open(false)}>打开<ArrowUpRight className="size-3" /></Button>
        <Button type="button" variant="outline" size="sm" className="h-7 px-2 text-xs" disabled={opening} aria-label={`接管${name}`} title="停止当前 Agent 并打开完整界面" onClick={() => void open(true)}>接管</Button>
      </div>
      {error && <p role="alert" className="px-2 pb-2 text-xs text-destructive">{error}</p>}
    </section>
  )
}

export function AgentFloatingPreviews({ sessionId, stopping }: { sessionId: string; stopping: boolean }): React.ReactElement | null {
  const store = useStore()
  const runAtom = React.useMemo(() => selectAtom(agentSessionStreamingStateAtomFamily(sessionId), state => ({
    generation: state?.running ? state.runGeneration : undefined,
    startedAt: state?.startedAt,
  }), (first, second) => first.generation === second.generation && first.startedAt === second.startedAt), [sessionId])
  const { generation, startedAt } = useAtomValue(runAtom)
  const currentSession = useAtomValue(currentAgentSessionIdAtom)
  const browser = useAtomValue(browserStateMapAtom).get(sessionId)
  const terminal = useAtomValue(agentTerminalPreviewAtom).get(sessionId)
  const terminalTabs = useAtomValue(agentTerminalTabsAtom).get(sessionId)
  const sideOpen = useAtomValue(agentSidePanelOpenAtomFamily(sessionId))
  const sideTab = useAtomValue(agentDiffPanelTabAtom).get(sessionId)
  const split = useAtomValue(agentSidePanelSplitMapAtom).get(sessionId)
  const dismissed = useAtomValue(dismissedPreviewsAtom).get(sessionId)
  if (generation === undefined || startedAt === undefined || stopping || currentSession !== sessionId) return null

  const hidden = dismissed?.runGeneration === generation ? dismissed.kinds : []
  const shown = (tab: string): boolean => sideOpen && (sideTab === tab || split?.leftTab === tab || split?.rightTab === tab)
  const targets: PreviewTarget[] = []
  const browserTab = browser?.tabs.find(tab => tab.tabId === browser.agentTabId)
  if (browserTab && browser?.activity?.tabId === browserTab.tabId && !browser.requiresRiskAcknowledgement &&
    shouldShowFloatingPreview({ startedAt, activityAt: browser.activity.at, dismissed: hidden.includes('browser'), fullViewOpen: shown(getBrowserSidePanelTab(browserTab.tabId)) })) {
    targets.push({ kind: 'browser', targetId: browserTab.tabId, title: browserTab.title || '浏览器' })
  }
  const terminalTab = terminalTabs?.find(tab => tab.terminalId === terminal?.terminalId)
  if (terminal && terminalTab &&
    shouldShowFloatingPreview({ startedAt, activityAt: terminal.at, dismissed: hidden.includes('terminal'), fullViewOpen: shown(getTerminalSidePanelTab(terminal.terminalId)) })) {
    targets.push({ kind: 'terminal', targetId: terminal.terminalId, title: terminalTab.title })
  }
  if (!targets.length) return null

  const hide = (kind: PreviewKind): void => {
    store.set(dismissedPreviewsAtom, previous => {
      const next = new Map([...previous].filter(([id, entry]) => {
        const state = store.get(agentSessionStreamingStateAtomFamily(id))
        return state?.running && state.runGeneration === entry.runGeneration
      }))
      const kinds = next.get(sessionId)?.kinds ?? []
      return next.set(sessionId, { runGeneration: generation, kinds: [...kinds, kind] })
    })
  }

  const open = async (target: PreviewTarget, takeOver: boolean): Promise<void> => {
    if (takeOver) await window.electronAPI.stopAgent(sessionId)
    if (store.get(currentAgentSessionIdAtom) !== sessionId) return
    if (target.kind === 'browser') {
      const state = await window.electronAPI.selectAgentBrowserTab({ sessionId, tabId: target.targetId })
      if (store.get(currentAgentSessionIdAtom) !== sessionId) return
      store.set(browserStateMapAtom, previous => new Map(previous).set(sessionId, state))
      store.set(browserPanelOpenMapAtom, previous => new Map(previous).set(sessionId, true))
      store.set(browserPanelMinimizedMapAtom, previous => new Map(previous).set(sessionId, false))
    } else {
      await window.electronAPI.retainAgentTerminal(sessionId, target.targetId)
      if (store.get(currentAgentSessionIdAtom) !== sessionId) return
    }
    const tab = target.kind === 'browser' ? getBrowserSidePanelTab(target.targetId) : getTerminalSidePanelTab(target.targetId)
    store.set(agentDiffPanelTabAtom, previous => new Map(previous).set(sessionId, tab))
    store.set(agentSidePanelOpenAtomFamily(sessionId), true)
  }

  return <div className="pointer-events-none absolute inset-2 z-20 overflow-hidden">
    {targets.map((target, index) => <FloatingPreviewCard key={`${generation}:${target.kind}:${target.targetId}`}
      sessionId={sessionId} runGeneration={generation} target={target} index={index}
      onHide={() => hide(target.kind)} onOpen={takeOver => open(target, takeOver)} />)}
  </div>
}
