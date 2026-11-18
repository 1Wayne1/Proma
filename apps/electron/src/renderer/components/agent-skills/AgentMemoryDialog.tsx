import * as React from 'react'
import { atom, Provider, useAtom } from 'jotai'
import type {
  MemoryDocument, MemoryFileList, MemoryHistoryEntry, MemoryInstructionLink, MemoryMigrationPlan,
  MemoryMigrationStatus, MemoryRestorePreview, MemoryScope, MemorySearchResult, MemoryTarget, MemoryWriteResult,
} from '@proma/shared'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'

interface MemorySession {
  target: MemoryTarget
  files: MemoryFileList
  path: string
  document: MemoryDocument
  history: MemoryHistoryEntry[]
}

type PendingAction =
  | { kind: 'archive' }
  | { kind: 'restore'; preview: MemoryRestorePreview }
  | { kind: 'migrate'; plan: MemoryMigrationPlan }
  | { kind: 'link'; preview: MemoryInstructionLink }

const openAtom = atom(false)
const busyAtom = atom(false)
const sessionAtom = atom<MemorySession | null>(null)
const draftAtom = atom('')
const noteAtom = atom('')
const queryAtom = atom('')
const hitsAtom = atom<MemorySearchResult | null>(null)
const pendingAtom = atom<PendingAction | null>(null)
const migrationResultAtom = atom<MemoryMigrationPlan | null>(null)
const statusAtom = atom<{ error: boolean; text: string } | null>(null)

const migrationLabels: Record<MemoryMigrationStatus, string> = {
  ready: '可导入', conflict: '有冲突，保留两份文件', present: '目标已有相同正文',
  unsupported: '跳过', imported: '已导入', failed: '失败',
}

function MigrationEntries({ result }: { result: MemoryMigrationPlan }): React.ReactElement {
  return (
    <>
      {result.items.length === 0 && <p className="text-sm text-muted-foreground">没有找到可检查的旧记忆。</p>}
      <ul className="max-h-44 space-y-1 overflow-auto text-sm" aria-label="迁移来源及状态">
        {result.items.map((item) => (
          <li key={item.source} className="break-all">
            {item.source} {item.path && <span className="text-muted-foreground">→ {item.path}</span>}
            <span className="ml-2 text-muted-foreground">{migrationLabels[item.status]}</span>
            {item.reason && <p className="text-xs text-muted-foreground">{item.reason}</p>}
          </li>
        ))}
      </ul>
      {result.partial && <p role="status" className="text-xs text-muted-foreground">已达到扫描预算，当前显示部分来源。</p>}
    </>
  )
}

interface MemoryDialogProps {
  scope: MemoryScope
  label?: string
  onChange?: () => void
}

/** 每个入口持有独立草稿，避免面板之间共享文件选择与未保存正文。 */
export function AgentMemoryDialog(props: MemoryDialogProps): React.ReactElement {
  const key = props.scope.kind === 'global' ? 'global' : props.scope.workspaceId
  return <Provider key={key}><MemoryDialogContent {...props} /></Provider>
}

function MemoryDialogContent({ scope, label, onChange }: MemoryDialogProps): React.ReactElement {
  const [open, setOpen] = useAtom(openAtom)
  const [busy, setBusy] = useAtom(busyAtom)
  const [session, setSession] = useAtom(sessionAtom)
  const [draft, setDraft] = useAtom(draftAtom)
  const [note, setNote] = useAtom(noteAtom)
  const [query, setQuery] = useAtom(queryAtom)
  const [hits, setHits] = useAtom(hitsAtom)
  const [pending, setPending] = useAtom(pendingAtom)
  const [migrationResult, setMigrationResult] = useAtom(migrationResultAtom)
  const [status, setStatus] = useAtom(statusAtom)
  const operation = React.useRef(false)
  const project = scope.kind === 'project'
  const title = project ? '项目记忆' : '全局协作画像'
  const primary = project ? 'MEMORY.md' : 'user_profile.md'
  const dirty = !!session && draft !== (session.document.content ?? '')
  const used = session?.document.usage ? draft.length : undefined
  const limit = session?.document.usage?.limit
  const overBudget = used !== undefined && limit !== undefined && used > limit

  async function run(job: () => Promise<void>): Promise<void> {
    if (operation.current) return
    operation.current = true
    setBusy(true)
    setStatus(null)
    try { await job() }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setStatus({ error: true, text: message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '') })
    } finally {
      operation.current = false
      setBusy(false)
    }
  }

  async function load(target: MemoryTarget, path: string): Promise<void> {
    const [document, files] = await Promise.all([
      window.electronAPI.agentMemory({ action: 'inspect', target, path }),
      window.electronAPI.agentMemory({ action: 'list', target }),
    ])
    setSession({ target, path, document, files, history: [] })
    setDraft(document.content ?? '')
    setPending(null)
    const history = await window.electronAPI.agentMemory({ action: 'history', target, path })
    setSession({ target, path, document, files, history })
  }

  function reopen(): void {
    void run(async () => {
      const target = await window.electronAPI.agentMemory({ action: 'target', scope })
      await load(target, primary)
    })
  }

  function handleOpen(next: boolean): void {
    if (!next && (dirty || operation.current)) {
      setStatus({ error: true, text: operation.current ? '正在处理，请稍候。' : '请先保存或放弃当前修改。' })
      return
    }
    setOpen(next)
    if (next) reopen()
    else {
      setSession(null)
      setDraft('')
      setPending(null)
      setNote('')
      setQuery('')
      setHits(null)
      setMigrationResult(null)
      setStatus(null)
    }
  }

  function selectPath(path: string): void {
    if (!session || dirty) return
    void run(() => load(session.target, path))
  }

  async function showWriteResult(result: MemoryWriteResult, active: MemorySession): Promise<void> {
    if (result.status === 'conflict') {
      setStatus({ error: true, text: '文件在读取后已变化。你的草稿仍在编辑框中，刷新后可基于最新内容重新编辑。' })
      return
    }
    if (result.status === 'over-budget') {
      setStatus({ error: true, text: `正文用了 ${result.usage.used} 个 UTF-16 码元，上限 ${result.usage.limit}。` })
      return
    }
    setPending(null)
    setSession({ ...active, document: result.document })
    setDraft(result.document.content ?? '')
    onChange?.()
    await load(active.target, active.path)
    setStatus({ error: false, text: result.status === 'unchanged' ? '正文没有变化。' : '变更已保存。' })
  }

  function save(): void {
    if (!session || overBudget) return
    const { target, path, document } = session
    void run(async () => {
      const result = await window.electronAPI.agentMemory({
        action: 'update', target, path, expectedRevision: document.revision, content: draft,
      })
      await showWriteResult(result, session)
    })
  }

  function applyPending(): void {
    if (!session || !pending || dirty) return
    const { target, path, document } = session
    void run(async () => {
      if (pending.kind === 'restore') {
        const result = await window.electronAPI.agentMemory({
          action: 'restore', target, path, expectedRevision: pending.preview.current.revision,
          revision: pending.preview.archived.revision!,
        })
        await showWriteResult(result, session)
      } else if (pending.kind === 'archive') {
        const result = await window.electronAPI.agentMemory({ action: 'archive', target, path, expectedRevision: document.revision })
        await showWriteResult(result, session)
      } else if (pending.kind === 'migrate') {
        setMigrationResult(await window.electronAPI.agentMemory({ action: 'migrate', target, planId: pending.plan.id }))
        setPending(null)
        onChange?.()
        await load(target, path)
      } else {
        await window.electronAPI.agentMemory({ action: 'linkInstruction', target, expectedRevision: pending.preview.revision })
        setPending(null)
        onChange?.()
        setStatus({ error: false, text: '已在项目指令中关联记忆索引。' })
      }
    })
  }

  const paths = session ? Array.from(new Set([...session.files.files, ...session.files.archived, session.path])) : []
  const restorationOverBudget = pending?.kind === 'restore' && !!pending.preview.archived.usage &&
    pending.preview.archived.usage.used > pending.preview.archived.usage.limit
  return (
    <Dialog open={open} onOpenChange={handleOpen}>
      <DialogTrigger asChild><Button size="sm" variant="outline">{label ?? title}</Button></DialogTrigger>
      <DialogContent className="max-h-[85vh] max-w-[min(760px,calc(100vw-2rem))] overflow-auto">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {project ? '编辑当前项目的索引和主题笔记，或检查旧记忆的导入来源。' : '跨项目使用的长期协作偏好。'}
          </DialogDescription>
        </DialogHeader>
        {status && <p role={status.error ? 'alert' : 'status'} className={status.error ? 'text-sm text-destructive' : 'text-sm text-muted-foreground'}>{status.text}</p>}
        {busy && <p role="status" className="text-xs text-muted-foreground">正在处理…</p>}
        {!session && !busy && <Button size="sm" variant="outline" onClick={reopen}>重试</Button>}
        {session && (
          <div className="min-w-0 space-y-3">
            {project && <div className="flex flex-wrap gap-2">
              <Select value={session.path} onValueChange={selectPath} disabled={busy || dirty}>
                <SelectTrigger aria-label="记忆文件" className="w-56 max-w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {paths.map((path) => <SelectItem key={path} value={path}>{path}{session.files.archived.includes(path) ? '（已归档）' : ''}</SelectItem>)}
                </SelectContent>
              </Select>
              <form className="flex gap-1" onSubmit={(event) => { event.preventDefault(); if (note.trim()) selectPath(`memory/${note.trim()}`) }}>
                <Input aria-label="新笔记文件名" placeholder="主题.md" value={note} onChange={(event) => setNote(event.target.value)} className="w-28" />
                <Button size="sm" type="submit" variant="outline" disabled={busy || dirty || !note.trim()}>打开或新建</Button>
              </form>
            </div>}
            {session.files.partial && <p role="status" className="text-xs text-muted-foreground">列表只显示可扫描的部分文件。</p>}
            {session.document.revision === null && <p className="text-xs text-muted-foreground">此文件尚未创建。可输入正文后保存，或显式创建空白文件。</p>}
            <Textarea
              aria-label={`${session.path} 正文`}
              className="min-h-40 resize-y font-mono text-sm"
              value={draft}
              disabled={busy}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
                  event.preventDefault()
                  if (dirty) save()
                }
              }}
            />
            {used !== undefined && <p className={overBudget ? 'text-xs text-destructive' : 'text-xs text-muted-foreground'}>{used} / {limit} 个 UTF-16 码元</p>}
            <div className="flex flex-wrap gap-2">
              <Button size="sm" onClick={save} disabled={busy || !dirty || overBudget}>保存</Button>
              <Button size="sm" variant="outline" disabled={busy} onClick={() => {
                void run(() => load(session.target, session.path))
              }}>{dirty ? '放弃修改并刷新' : '刷新'}</Button>
              {session.document.revision === null ? (
                <Button size="sm" variant="outline" disabled={busy || dirty} onClick={() => void run(async () => {
                  const result = await window.electronAPI.agentMemory({ action: 'initialize', target: session.target, path: session.path })
                  await showWriteResult(result, session)
                })}>创建空白文件</Button>
              ) : <Button size="sm" variant="outline" disabled={busy || dirty} onClick={() => setPending({ kind: 'archive' })}>归档</Button>}
              {project && <>
                <Button size="sm" variant="outline" disabled={busy || dirty} onClick={() => void run(async () => {
                  setMigrationResult(null)
                  setPending({ kind: 'migrate', plan: await window.electronAPI.agentMemory({ action: 'migrationPreview', target: session.target }) })
                })}>预览旧记忆导入</Button>
                <Button size="sm" variant="outline" disabled={busy || dirty} onClick={() => void run(async () => {
                  setPending({ kind: 'link', preview: await window.electronAPI.agentMemory({ action: 'instructionPreview', target: session.target }) })
                })}>关联项目指令</Button>
              </>}
            </div>
            {session.history.length > 0 && <details className="rounded-md border p-2">
              <summary className="cursor-pointer text-sm">历史版本（{session.history.length}）</summary>
              {session.history.map(({ revision, savedAt }) => (
                <div key={revision} className="flex flex-wrap items-center justify-between gap-2 py-1 text-xs">
                  <span>{new Date(savedAt).toLocaleString()} · {revision.slice(0, 10)}</span>
                  <Button size="sm" variant="ghost" disabled={busy || dirty} onClick={() => void run(async () => {
                    setPending({ kind: 'restore', preview: await window.electronAPI.agentMemory({ action: 'restorePreview', target: session.target, path: session.path, revision }) })
                  })}>预览恢复</Button>
                </div>
              ))}
            </details>}
            {pending && (
              <section aria-label="变更预览" className="space-y-2 rounded-md border bg-muted/25 p-3">
                {pending.kind === 'archive' && <p className="text-sm">归档 {session.path} 后，可从历史版本恢复。</p>}
                {pending.kind === 'link' && <p className="text-sm">{pending.preview.linked ? `${pending.preview.path} 已包含记忆链接。` : `在 ${pending.preview.path} 末尾追加项目记忆链接。`}</p>}
                {pending.kind === 'migrate' && <MigrationEntries result={pending.plan} />}
                {pending.kind === 'restore' && <>
                  <div className="grid gap-2 sm:grid-cols-2">
                    {[['当前正文', pending.preview.current.content], ['待恢复正文', pending.preview.archived.content]].map(([name, text]) => (
                      <div key={name}>
                        <div className="text-xs font-medium">{name}</div>
                        <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words text-xs">{text ?? '（文件不存在）'}</pre>
                      </div>
                    ))}
                  </div>
                  {restorationOverBudget && <p className="text-xs text-destructive">待恢复版本超出当前画像预算。</p>}
                </>}
                <div className="flex gap-2">
                  <Button size="sm" variant="outline" disabled={busy} onClick={() => setPending(null)}>取消</Button>
                  <Button size="sm" onClick={applyPending} disabled={busy || dirty || restorationOverBudget ||
                    (pending.kind === 'migrate' && !pending.plan.items.some((item) => item.status === 'ready')) ||
                    (pending.kind === 'link' && pending.preview.linked)}>
                    {pending.kind === 'migrate' ? '导入可迁移项' : pending.kind === 'restore' ? '确认恢复' : pending.kind === 'archive' ? '确认归档' : '确认关联'}
                  </Button>
                </div>
              </section>
            )}
            {migrationResult && <section aria-label="导入结果" className="space-y-2 rounded-md border p-3"><MigrationEntries result={migrationResult} /></section>}
            <form className="flex gap-2" onSubmit={(event) => {
              event.preventDefault()
              if (!query.trim()) return
              void run(async () => setHits(await window.electronAPI.agentMemory({ action: 'search', target: session.target, query })))
            }}>
              <Input value={query} onChange={(event) => setQuery(event.target.value)} maxLength={200} aria-label="搜索记忆" placeholder="搜索记忆" />
              <Button type="submit" size="sm" variant="outline" disabled={busy || !query.trim()}>搜索</Button>
            </form>
            {hits && <div className="max-h-40 space-y-1 overflow-auto text-sm" aria-label="搜索结果">
              {hits.hits.length === 0 && <p className="text-muted-foreground">未找到匹配内容。</p>}
              {hits.hits.map((hit) => <button key={`${hit.path}:${hit.line}`} type="button" disabled={busy || dirty}
                className="block w-full break-all rounded px-2 py-1 text-left hover:bg-accent focus-visible:outline focus-visible:outline-ring"
                onClick={() => selectPath(hit.path)}>{hit.path} · 第 {hit.line} 行 <span className="text-muted-foreground">{hit.snippet}</span></button>)}
              {hits.partial && <p className="text-xs text-muted-foreground">结果已达到扫描或显示上限。</p>}
            </div>}
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
