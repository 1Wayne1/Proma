/**
 * LegacyChatSettings - 历史 Chat（只读查看与 Agent 协助准备）设置页
 */

import * as React from 'react'
import { atom, useAtomValue, useStore } from 'jotai'
import { toast } from 'sonner'
import {
  ArrowUpRight,
  ChevronLeft,
  ChevronRight,
  History,
  Loader2,
  MessageSquare,
  RefreshCw,
  Search,
  ShieldCheck,
  Wrench,
} from 'lucide-react'
import type {
  AgentSessionMeta,
  LegacyChatArchivedFilter,
  LegacyChatHistoryItem,
  LegacyChatHistoryPage,
  LegacyChatSnapshotKind,
  LegacyChatSummary,
} from '@proma/shared'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { SettingsSection } from './primitives/SettingsSection'
import { settingsOpenAtom, settingsTabAtom } from '@/atoms/settings-tab'
import {
  agentChannelIdAtom,
  agentModelIdAtom,
  agentPendingPromptAtom,
  agentSessionsAtom,
  currentAgentWorkspaceIdAtom,
} from '@/atoms/agent-atoms'
import { useOpenSession } from '@/hooks/useOpenSession'
import {
  LEGACY_CHAT_PAGE_SIZE,
  formatLegacyChatTimestamp,
  legacyChatEntryKey,
  reconcileLegacyChatEntry,
  runLegacyChatPreparation,
  type LegacyChatPreparationEntry,
} from './legacy-chat-helpers'

const legacyChatPrepMapAtom = atom<Map<string, LegacyChatPreparationEntry>>(new Map())

interface LegacyChatHistoryListProps {
  refreshKey: number
  busy: boolean
  onProcess: (conversation: LegacyChatHistoryItem) => void
}

function LegacyChatHistoryList({
  refreshKey,
  busy,
  onProcess,
}: LegacyChatHistoryListProps): React.ReactElement {
  const [query, setQuery] = React.useState('')
  const [archivedFilter, setArchivedFilter] = React.useState<LegacyChatArchivedFilter>('all')
  const [offset, setOffset] = React.useState(0)
  const [page, setPage] = React.useState<LegacyChatHistoryPage | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [loadFailed, setLoadFailed] = React.useState(false)
  const [retryTick, setRetryTick] = React.useState(0)

  const currentWorkspaceId = useAtomValue(currentAgentWorkspaceIdAtom)
  const prepMap = useAtomValue(legacyChatPrepMapAtom)

  React.useEffect(() => {
    let active = true
    setLoading(true)
    setLoadFailed(false)

    const timer = setTimeout(() => {
      window.electronAPI
        .listLegacyChats({
          query: query.trim(),
          archived: archivedFilter,
          offset,
          limit: LEGACY_CHAT_PAGE_SIZE,
        })
        .then((result) => {
          if (!active) return
          if (offset > 0 && offset >= result.total) {
            setOffset(
              Math.max(
                0,
                Math.floor((result.total - 1) / LEGACY_CHAT_PAGE_SIZE) * LEGACY_CHAT_PAGE_SIZE,
              ),
            )
            return
          }
          setPage(result)
        })
        .catch(() => {
          if (active) setLoadFailed(true)
        })
        .finally(() => {
          if (active) setLoading(false)
        })
    }, query ? 200 : 0)

    return () => {
      active = false
      clearTimeout(timer)
    }
  }, [query, archivedFilter, offset, retryTick, refreshKey])

  return (
    <SettingsSection
      title="历史对话"
      description="按标题查找，选择一条记录交给 Agent 阅读、整理或继续处理。不会打开旧 Chat 模式。"
    >
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative min-w-[180px] flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            type="search"
            aria-label="搜索历史 Chat 标题"
            placeholder="搜索对话标题…"
            maxLength={200}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value)
              setOffset(0)
            }}
            className="h-10 pl-9"
          />
        </div>
        <select
          aria-label="筛选历史 Chat 状态"
          value={archivedFilter}
          onChange={(event) => {
            const value = event.target.value
            if (value === 'all' || value === 'active' || value === 'archived') {
              setArchivedFilter(value)
              setOffset(0)
            }
          }}
          className="h-10 rounded-md border border-input bg-background px-3 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
        >
          <option value="all">全部记录</option>
          <option value="active">未归档</option>
          <option value="archived">已归档</option>
        </select>
      </div>

      <div aria-busy={loading} className="overflow-hidden rounded-xl border border-border/60 bg-card/50">
        {loading ? (
          <div role="status" className="flex min-h-36 items-center justify-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            正在加载历史记录…
          </div>
        ) : loadFailed ? (
          <div role="alert" className="flex min-h-36 flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
            <p>暂时无法读取历史记录。</p>
            <Button variant="outline" onClick={() => setRetryTick((value) => value + 1)}>
              重试
            </Button>
          </div>
        ) : (
          <>
            {page?.status === 'invalid' && (
              <p role="status" className="border-b border-border/50 bg-amber-500/5 px-4 py-3 text-xs text-muted-foreground">
                部分历史索引无法读取，仅展示可读取的记录。原始资料未修改。
              </p>
            )}
            {page?.items.length ? (
              <ul className="divide-y divide-border/50">
                {page.items.map((item) => {
                  const rowEntry = prepMap.get(legacyChatEntryKey(currentWorkspaceId, 'history', item.id))
                  const displayTitle = item.title.trim() || '未命名对话'
                  return (
                    <li key={item.id} className="px-4 py-3 transition-colors hover:bg-muted/30">
                      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                        <MessageSquare className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                        <div className="min-w-0 flex-1 basis-40">
                          <div className="flex min-w-0 items-center gap-2">
                            <span className="truncate text-sm font-medium" title={item.title}>
                              {displayTitle}
                            </span>
                            {item.archived && (
                              <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                                已归档
                              </span>
                            )}
                          </div>
                          <p className="mt-1 text-xs tabular-nums text-muted-foreground">
                            更新于 {formatLegacyChatTimestamp(item.updatedAt ?? item.createdAt)}
                          </p>
                        </div>
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-10 shrink-0 active:scale-[0.96]"
                          disabled={busy}
                          aria-label={`用 Agent 处理：${displayTitle}`}
                          onClick={() => onProcess(item)}
                        >
                          {rowEntry?.busy ? <Loader2 className="animate-spin" /> : <ArrowUpRight />}
                          用 Agent 处理
                        </Button>
                      </div>
                      {rowEntry?.error && (
                        <p role="alert" className="mt-2 text-xs text-destructive">
                          {rowEntry.error} 可重试，原记录未修改。
                        </p>
                      )}
                      {rowEntry?.preparation && !rowEntry.busy && (
                        <p className="mt-2 text-xs text-muted-foreground">
                          资料已准备，再次点击可打开对应 Agent 会话。
                        </p>
                      )}
                    </li>
                  )
                })}
              </ul>
            ) : (
              <div className="flex min-h-36 items-center justify-center text-sm text-muted-foreground">
                {query || archivedFilter !== 'all' ? '没有符合条件的历史对话' : '此设备暂未发现历史 Chat 记录'}
              </div>
            )}
          </>
        )}
      </div>

      {!loading && !loadFailed && page && (
        <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-muted-foreground">
          <span className="tabular-nums">
            共 {page.total} 条{page.total > 0 ? ` · ${offset + 1}–${Math.min(offset + LEGACY_CHAT_PAGE_SIZE, page.total)}` : ''}
          </span>
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              className="h-10"
              disabled={offset === 0}
              onClick={() => setOffset((value) => Math.max(0, value - LEGACY_CHAT_PAGE_SIZE))}
            >
              <ChevronLeft />
              上一页
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-10"
              disabled={offset + LEGACY_CHAT_PAGE_SIZE >= page.total}
              onClick={() => setOffset((value) => value + LEGACY_CHAT_PAGE_SIZE)}
            >
              下一页
              <ChevronRight />
            </Button>
          </div>
        </div>
      )}
    </SettingsSection>
  )
}

export function LegacyChatSettings(): React.ReactElement {
  const store = useStore()
  const openSession = useOpenSession()
  const [summary, setSummary] = React.useState<LegacyChatSummary | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [loadFailed, setLoadFailed] = React.useState(false)
  const [refreshKey, setRefreshKey] = React.useState(0)

  const currentWorkspaceId = useAtomValue(currentAgentWorkspaceIdAtom)
  const prepMap = useAtomValue(legacyChatPrepMapAtom)
  const historyEntry = prepMap.get(legacyChatEntryKey(currentWorkspaceId, 'history'))
  const toolsEntry = prepMap.get(legacyChatEntryKey(currentWorkspaceId, 'tools'))
  const anyBusy = [...prepMap.values()].some(
    (entry) => entry.busy && entry.workspaceId === currentWorkspaceId,
  )

  const mountedRef = React.useRef(false)
  const loadGenRef = React.useRef(0)

  const loadSummary = React.useCallback(async (): Promise<void> => {
    const gen = ++loadGenRef.current
    setLoading(true)
    setLoadFailed(false)
    try {
      const result = await window.electronAPI.getLegacyChatSummary()
      if (gen === loadGenRef.current) {
        setSummary(result)
        setRefreshKey((value) => value + 1)
      }
    } catch {
      if (gen === loadGenRef.current) {
        setLoadFailed(true)
      }
    } finally {
      if (gen === loadGenRef.current) {
        setLoading(false)
      }
    }
  }, [])

  React.useEffect(() => {
    mountedRef.current = true
    void loadSummary()
    return () => {
      mountedRef.current = false
      loadGenRef.current++
    }
  }, [loadSummary])

  const handlePrepare = async (
    kind: LegacyChatSnapshotKind,
    conversation?: LegacyChatHistoryItem,
  ): Promise<void> => {
    const workspaceId = store.get(currentAgentWorkspaceIdAtom)
    const key = legacyChatEntryKey(workspaceId, kind, conversation?.id)
    const currentMap = store.get(legacyChatPrepMapAtom)
    if ([...currentMap.values()].some((item) => item.busy && item.workspaceId === workspaceId)) {
      return
    }

    const entry: LegacyChatPreparationEntry = {
      ...(currentMap.get(key) ?? {}),
      workspaceId,
      conversationId: conversation?.id,
      busy: true,
    }
    delete entry.error
    store.set(legacyChatPrepMapAtom, new Map(currentMap).set(key, entry))

    try {
      if (entry.session) {
        const activeSession = (await window.electronAPI.listActiveAgentSessions()).find(
          (session) => session.id === entry.session?.id,
        )
        reconcileLegacyChatEntry(entry, activeSession, workspaceId)
      }

      await runLegacyChatPreparation(
        kind,
        entry,
        {
          create: (title) =>
            window.electronAPI.createAgentSession(
              title,
              store.get(agentChannelIdAtom) ?? undefined,
              workspaceId ?? undefined,
              store.get(agentModelIdAtom) ?? undefined,
            ),
          prepare: (sessionId, snapshotKind, conversationId) =>
            window.electronAPI.prepareLegacyChatSession(sessionId, snapshotKind, conversationId),
          prefill: (sessionId, message) => {
            store.set(agentPendingPromptAtom, { sessionId, message })
          },
          open: (session: AgentSessionMeta) => {
            if (
              !mountedRef.current
              || !store.get(settingsOpenAtom)
              || store.get(settingsTabAtom) !== 'legacy-chat'
              || store.get(currentAgentWorkspaceIdAtom) !== workspaceId
            ) {
              return
            }

            store.set(agentSessionsAtom, (prev) =>
              prev.some((item) => item.id === session.id) ? prev : [session, ...prev],
            )
            const openedSession =
              store.get(agentSessionsAtom).find((item) => item.id === session.id) ?? session

            openSession('agent', openedSession.id, openedSession.title, {
              onOpened: () => {
                store.set(legacyChatPrepMapAtom, (prev) => {
                  const next = new Map(prev)
                  next.delete(key)
                  return next
                })
                toast.success('已打开 Agent 会话', {
                  description: entry.preparation?.warnings.length
                    ? '提示词已填入；资料有读取限制，请先查看索引说明，再确认发送。'
                    : '提示词已填入，确认后发送即可。原始资料保持不变。',
                })
              },
            })
          },
        },
        conversation,
      )
    } catch (error) {
      entry.error = error instanceof Error ? error.message : '暂时无法准备资料，请重试。'
    } finally {
      entry.busy = false
      store.set(legacyChatPrepMapAtom, (curr) => (curr.get(key) === entry ? new Map(curr) : curr))
    }
  }

  const customToolCount = summary?.toolsStatus === 'available' ? summary.customToolCount : 0
  const summaryUnavailable = loading || loadFailed || !summary

  return (
    <div className="space-y-6">
      <SettingsSection
        title="历史 Chat"
        description="此设备上的历史记录和自定义工具仍会保留。让 Agent 帮你查找旧对话，或把工具整理为 Skills。"
        action={
          <Button
            variant="ghost"
            size="icon"
            className="size-10"
            aria-label="刷新历史 Chat 资料"
            disabled={loading || anyBusy}
            onClick={() => void loadSummary()}
          >
            <RefreshCw className={loading ? 'animate-spin' : ''} />
          </Button>
        }
      >
        {loadFailed ? (
          <div role="alert" className="flex items-center justify-between gap-3 rounded-lg bg-destructive/5 p-3 text-sm">
            <span>暂时无法读取本机资料。</span>
            <Button variant="ghost" size="sm" onClick={() => void loadSummary()}>
              <RefreshCw />
              重试
            </Button>
          </div>
        ) : (
          <div className="grid gap-4 lg:grid-cols-2" aria-busy={loading}>
            <section className="flex flex-col rounded-xl border border-border/60 bg-card/50 p-5">
              <div className="flex items-center gap-2 text-sm font-medium">
                <History size={16} />
                <h3>历史 Chat 记录</h3>
                <span className="ml-auto text-xs font-normal text-muted-foreground tabular-nums">
                  {loading
                    ? '读取中…'
                    : summary?.historyStatus === 'invalid'
                      ? '读取异常'
                      : `${summary?.conversationCount ?? 0} 个对话`}
                </span>
              </div>
              <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                在新 Agent 会话中按主题查找、阅读和整理旧对话，包含已归档记录，不改动原始资料。
              </p>
              {summary?.historyStatus === 'invalid' && (
                <p role="alert" className="mt-2 text-xs text-destructive">
                  历史索引无法读取，请先检查本机资料或备份。
                </p>
              )}
              {!loading && summary?.historyStatus !== 'invalid' && !summary?.conversationCount && (
                <p className="mt-2 text-xs text-muted-foreground">
                  此设备暂未发现历史 Chat 记录。
                </p>
              )}
              {historyEntry?.error && (
                <p role="alert" className="mt-3 text-xs text-destructive">
                  {historyEntry.error} 原始资料未修改，可点击下方重试。
                </p>
              )}
              {historyEntry?.preparation && !historyEntry.busy && (
                <p className="mt-3 text-xs text-muted-foreground">
                  资料已准备，可继续打开原会话。
                </p>
              )}
              <Button
                variant="outline"
                className="mt-4 h-10 w-full active:scale-[0.96]"
                disabled={
                  summaryUnavailable
                  || anyBusy
                  || summary.historyStatus !== 'available'
                  || summary.conversationCount === 0
                }
                onClick={() => void handlePrepare('history')}
              >
                {historyEntry?.busy ? <Loader2 className="animate-spin" /> : <ArrowUpRight />}
                用 Agent 读取历史
              </Button>
            </section>

            <section className="flex flex-col rounded-xl border border-border/60 bg-card/50 p-5">
              <div className="flex items-center gap-2 text-sm font-medium">
                <Wrench size={16} />
                <h3>自定义 Chat 工具</h3>
                <span className="ml-auto text-xs font-normal text-muted-foreground tabular-nums">
                  {loading
                    ? '读取中…'
                    : summary?.toolsStatus === 'invalid'
                      ? '读取异常'
                      : `${summary?.customToolCount ?? 0} 个工具`}
                </span>
              </div>
              <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                把已有工具整理为 Agent 可用的 Skill 草案。密钥不随资料导出，所需配置由你确认后补充。
              </p>
              {summary?.toolsStatus === 'invalid' && (
                <p role="alert" className="mt-2 text-xs text-destructive">
                  工具配置无法读取，原文件保持不变。
                </p>
              )}
              {!loading && summary?.toolsStatus !== 'invalid' && !customToolCount && (
                <p className="mt-2 text-xs text-muted-foreground">
                  此设备暂未发现自定义工具，内置工具无需迁移。
                </p>
              )}
              {toolsEntry?.error && (
                <p role="alert" className="mt-3 text-xs text-destructive">
                  {toolsEntry.error} 原始工具未修改，可点击下方重试。
                </p>
              )}
              {toolsEntry?.preparation && !toolsEntry.busy && (
                <p className="mt-3 text-xs text-muted-foreground">
                  资料已准备，可继续打开原会话。
                </p>
              )}
              <Button
                variant="outline"
                className="mt-4 h-10 w-full active:scale-[0.96]"
                disabled={
                  summaryUnavailable
                  || anyBusy
                  || summary.toolsStatus !== 'available'
                  || customToolCount === 0
                }
                onClick={() => void handlePrepare('tools')}
              >
                {toolsEntry?.busy ? <Loader2 className="animate-spin" /> : <ArrowUpRight />}
                转换为 Skills
              </Button>
            </section>
          </div>
        )}
      </SettingsSection>

      <LegacyChatHistoryList
        refreshKey={refreshKey}
        busy={anyBusy}
        onProcess={(conversation) => void handlePrepare('history', conversation)}
      />

      <p className="flex items-start gap-2 text-xs leading-relaxed text-muted-foreground">
        <ShieldCheck className="mt-0.5 size-3.5 shrink-0" />
        只准备本机资料并填入提示词。由你确认发送，不会自动执行旧指令或调用工具。
      </p>
    </div>
  )
}
