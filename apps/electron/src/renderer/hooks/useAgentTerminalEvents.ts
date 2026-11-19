import { useEffect } from 'react'
import { useStore } from 'jotai'
import type { AgentTerminalActivity, AgentTerminalCloseEvent, AgentTerminalOpenEvent } from '@proma/shared'
import {
  agentDiffPanelTabAtom,
  agentTerminalActivityAtom,
  agentTerminalPreviewAtom,
  agentTerminalTabsAtom,
  getTerminalSidePanelTab,
} from '@/atoms/agent-atoms'

export function useAgentTerminalEvents(): void {
  const store = useStore()
  useEffect(() => {
    let disposed = false
    const touchedTerminals = new Set<string>()
    const touchedSessions = new Set<string>()
    let restoring = true

    const openTab = (event: AgentTerminalOpenEvent): void => {
      const { sessionId, terminalId, title, cwd } = event
      store.set(agentTerminalTabsAtom, previous => {
        const tabs = previous.get(sessionId) ?? []
        if (tabs.some(tab => tab.terminalId === terminalId)) return previous
        return new Map(previous).set(sessionId, [...tabs, { terminalId, title, cwd, agentOwned: true }])
      })
    }
    const closeTab = ({ sessionId, terminalId }: AgentTerminalCloseEvent): void => {
      store.set(agentTerminalTabsAtom, previous => {
        const tabs = previous.get(sessionId) ?? []
        const remaining = tabs.filter(tab => tab.terminalId !== terminalId)
        if (remaining.length === tabs.length) return previous
        const next = new Map(previous)
        if (remaining.length) next.set(sessionId, remaining)
        else next.delete(sessionId)
        return next
      })
      store.set(agentDiffPanelTabAtom, previous => {
        if (previous.get(sessionId) !== getTerminalSidePanelTab(terminalId)) return previous
        return new Map(previous).set(sessionId, 'files')
      })
    }
    const setActivity = ({ sessionId, terminalIds, preview }: AgentTerminalActivity): void => {
      store.set(agentTerminalActivityAtom, previous => {
        const next = new Map(previous)
        if (terminalIds.length) next.set(sessionId, terminalIds)
        else next.delete(sessionId)
        return next
      })
      store.set(agentTerminalPreviewAtom, previous => {
        const current = previous.get(sessionId)
        if (current?.terminalId === preview?.terminalId && current?.at === preview?.at) return previous
        const next = new Map(previous)
        if (preview) next.set(sessionId, preview)
        else next.delete(sessionId)
        return next
      })
    }

    const unsubscribeOpen = window.electronAPI.onAgentTerminalOpen(event => {
      if (restoring) touchedTerminals.add(event.terminalId)
      openTab(event)
    })
    const unsubscribeClose = window.electronAPI.onAgentTerminalClose(event => {
      if (restoring) touchedTerminals.add(event.terminalId)
      closeTab(event)
    })
    const unsubscribeActivity = window.electronAPI.onAgentTerminalActivity(event => {
      if (restoring) touchedSessions.add(event.sessionId)
      setActivity(event)
    })
    void window.electronAPI.getAgentTerminalCatalog().then(catalog => {
      if (disposed) return
      for (const terminal of catalog.terminals) {
        if (!touchedTerminals.has(terminal.terminalId)) openTab(terminal)
      }
      for (const activity of catalog.activity) {
        if (!touchedSessions.has(activity.sessionId)) setActivity(activity)
      }
    }).catch(error => console.warn('[终端] 恢复终端列表失败:', error)).finally(() => {
      restoring = false
      touchedTerminals.clear()
      touchedSessions.clear()
    })
    return () => {
      disposed = true
      unsubscribeOpen()
      unsubscribeClose()
      unsubscribeActivity()
    }
  }, [store])
}
