/**
 * WelcomeView — 主区域空状态启动器
 *
 * 当没有打开任何标签页时：
 * 1. 优先复用现有当前项目内的 Agent 会话
 * 2. 没有现有会话时，创建一个 draft Agent 会话（不在侧边栏显示）
 */

import * as React from 'react'
import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import { Loader2 } from 'lucide-react'
import { currentAgentWorkspaceIdAtom, agentSettingsReadyAtom } from '@/atoms/agent-atoms'
import { tabsAtom, activeTabIdAtom, openTab } from '@/atoms/tab-atoms'
import { draftSessionIdsAtom } from '@/atoms/draft-session-atoms'
import { useCreateSession } from '@/hooks/useCreateSession'

export function WelcomeView(): React.ReactElement {
  const currentWorkspaceId = useAtomValue(currentAgentWorkspaceIdAtom)
  const agentSettingsReady = useAtomValue(agentSettingsReadyAtom)
  const draftSessionIds = useAtomValue(draftSessionIdsAtom)
  const [tabs, setTabs] = useAtom(tabsAtom)
  const setActiveTabId = useSetAtom(activeTabIdAtom)
  const { createAgent } = useCreateSession()
  const initRef = React.useRef(false)

  // 将高频变化的值收集到 ref 中，避免污染 useEffect 依赖数组
  const latestRef = React.useRef({
    tabs,
    draftSessionIds,
    currentWorkspaceId,
    setTabs,
    setActiveTabId,
    createAgent,
  })
  latestRef.current = {
    tabs,
    draftSessionIds,
    currentWorkspaceId,
    setTabs,
    setActiveTabId,
    createAgent,
  }

  React.useEffect(() => {
    if (initRef.current) return
    if (!agentSettingsReady) return

    initRef.current = true

    window.electronAPI.listActiveAgentSessions().then((freshSessions) => {
      const {
        tabs: currentTabs,
        draftSessionIds: currentDrafts,
        currentWorkspaceId: currentWs,
        setTabs: currentSetTabs,
        setActiveTabId: currentSetActiveTabId,
        createAgent: currentCreateAgent,
      } = latestRef.current

      // 按当前工作区过滤。持久化草稿在侧栏中无入口，必须优先恢复，
      // 否则同项目的普通会话会让草稿永久不可访问。
      const draftSession = freshSessions.find(
        (s) => !s.archived && s.workspaceId === currentWs && (s.isDraft || currentDrafts.has(s.id)),
      )
      if (draftSession) {
        const result = openTab(currentTabs, {
          type: 'agent',
          sessionId: draftSession.id,
          title: draftSession.title,
        })
        currentSetTabs(result.tabs)
        currentSetActiveTabId(result.activeTabId)
        return
      }

      // 没有草稿时，复用现有普通会话。
      const existing = freshSessions.find(
        (s) => !s.archived && s.workspaceId === currentWs && !s.isDraft && !currentDrafts.has(s.id),
      )
      if (existing) {
        const result = openTab(currentTabs, {
          type: 'agent',
          sessionId: existing.id,
          title: existing.title,
        })
        currentSetTabs(result.tabs)
        currentSetActiveTabId(result.activeTabId)
        return
      }

      // 没有任何会话时才创建新的 draft 会话
      void currentCreateAgent({ draft: true })
    }).catch(console.error)
  }, [agentSettingsReady])

  // 短暂的过渡状态（通常几十毫秒内就会被 TabContent 替换）
  return (
    <div className="flex h-full items-center justify-center">
      <Loader2 className="size-5 animate-spin text-muted-foreground/40" />
    </div>
  )
}
