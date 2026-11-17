import { TurnRestoreControls } from './TurnRestoreControls'
import * as React from 'react'
import { useAtom } from 'jotai'
import type { TurnChangeLimitation, TurnChangeRecord, TurnDiffSide, TurnFileChange } from '@proma/shared'
import { Button } from '@/components/ui/button'
import { useMessageSessionId } from '@/components/ai-elements/message'
import { DiffView } from '@/components/diff/DiffView'
import { createTurnChangesController, createTurnChangesViewAtom } from '@/atoms/turn-changes-atoms'

const changeLabels: Record<TurnFileChange['kind'], string> = { added: '新增', modified: '修改', deleted: '删除', unknown: '变更未确认' }
const completionLabels: Record<TurnChangeRecord['completion'], string> = { recording: '未完成收束', completed: '执行完成', cancelled: '已取消', failed: '执行失败' }
const reasonLabels: Record<TurnChangeLimitation, string> = {
  'file-limit': '文件数量超过限额', 'git-output-limit': 'Git 输出超过限额', 'git-unavailable': 'Git 状态不可用', 'git-timeout': 'Git 查询超时', 'git-invalid-path': '部分 Git 路径不可采样',
  'additional-root-not-captured': '部分文件位于本次采样根之外', 'too-large': '单文件超过限额', 'budget-exceeded': '快照总容量不足', 'unsafe-path': '路径无法安全采样', 'not-file': '不是普通文件', unreadable: '文件无法读取', 'changed-during-read': '采样期间文件变化', 'not-captured': '缺少快照',
}

function unavailableLabel(side: TurnDiffSide): string {
  if (side.snapshot.format === 'binary') return '二进制文件不提供文本差异'
  return side.snapshot.reason ? reasonLabels[side.snapshot.reason] : '无可用文本快照'
}

export function TurnChangesPanel({ turnId }: { turnId?: string }): React.ReactElement | null {
  const sessionId = useMessageSessionId()
  return sessionId && turnId ? <TurnChangesPanelBody key={JSON.stringify([sessionId, turnId])} sessionId={sessionId} turnId={turnId} /> : null
}

export function TurnChangesPanelBody({ sessionId, turnId }: { sessionId: string; turnId: string }): React.ReactElement {
  const stateAtom = React.useMemo(createTurnChangesViewAtom, [sessionId, turnId])
  const [state, setState] = useAtom(stateAtom)
  const [open, setOpen] = React.useState(false)
  const controller = React.useRef<ReturnType<typeof createTurnChangesController> | null>(null)
  React.useEffect(() => {
    const active = createTurnChangesController(window.electronAPI, { sessionId, turnId }, patch => setState(previous => ({ ...previous, ...patch })))
    controller.current = active
    return () => { active.dispose(); if (controller.current === active) controller.current = null }
  }, [sessionId, turnId, setState])
  React.useEffect(() => {
    if (!open) return
    const release = window.electronAPI.onTurnChangesChanged(owner => {
      if (owner.sessionId === sessionId && owner.turnId === turnId) void controller.current?.load()
    })
    void controller.current?.load()
    return release
  }, [open, sessionId, turnId])
  const record = state.records.find(record => record.recordId === state.selectedRecordId)
  const regionId = React.useId()
  const selectedFile = record?.files.find(file => file.path === state.selectedPath)
  return <div className="mt-3 pl-[46px] text-sm">
    <Button size="sm" variant="outline" aria-expanded={open} aria-controls={regionId} onClick={() => {
      setOpen(previous => !previous)
    }}>{open ? '收起本轮文件差异' : '查看本轮文件差异'}</Button>
    {open && <section id={regionId} aria-label="本轮文件差异" className="mt-2 space-y-3 rounded-md border border-border bg-background p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-muted-foreground">查看本轮最近 10 次执行的快照</span>
        <Button size="sm" variant="ghost" disabled={state.loading} onClick={() => { void controller.current?.load() }}>刷新记录</Button>
      </div>
      <div role="status" aria-live="polite">
        {state.loading && <p>正在读取变更记录…</p>}
        {state.error && <p className="text-destructive">{state.error}</p>}
        {!state.loading && !state.error && state.records.length === 0 && <p className="text-muted-foreground">本轮没有快照记录。历史消息、未绑定项目或采样未启动的执行可能没有记录。</p>}
      </div>
      {!state.loading && !state.error && record && <>
        <label className="block text-xs">执行记录
          <select value={record.recordId} onChange={event => controller.current?.selectRecord(event.target.value)} className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1">
            {state.records.map(item => <option key={item.recordId} value={item.recordId}>{new Date(item.startedAt).toLocaleString()} · {completionLabels[item.completion]}</option>)}
          </select>
        </label>
        <p className="text-xs text-muted-foreground">{record.coverage.mode === 'controlled-only' ? '仅覆盖已采样的受控工具文件；未覆盖未知 Shell 和外部写入。' : '包含本轮期间 Git 观察到的变化，可能含用户或其他程序的修改。'}</p>
        {record.partial && <p role="status" className="text-xs text-muted-foreground">记录不完整：{record.limitations.length ? record.limitations.map(reason => reasonLabels[reason]).join('；') : '本轮未正常结束'}。</p>}
        {record.files.length === 0 ? <p className="text-muted-foreground">{record.completion === 'recording' ? '采样尚未收束，可稍后刷新查看。' : '本轮未观察到文件变化。'}</p> : <ul aria-label="本轮变更文件" className="max-h-48 space-y-1 overflow-auto">
          {record.files.map(file => <li key={file.path}>
            <button type="button" aria-pressed={state.selectedPath === file.path} onClick={() => { void controller.current?.loadDiff(record.recordId, file.path) }}
              className="w-full rounded px-2 py-1 text-left hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring aria-pressed:bg-muted">
              <span className="break-all">{changeLabels[file.kind]} · {file.path}</span>
              <span className="ml-2 text-xs text-muted-foreground">{file.source === 'controlled-tool' ? '受控工具捕获' : 'Git 观察'}</span>
            </button>
          </li>)}
        </ul>}
        <div role="status" aria-live="polite">
          {state.diffLoading && <p>正在读取文件快照…</p>}
          {state.diffError && <div><p className="text-destructive">{state.diffError}</p><Button size="sm" variant="outline" onClick={() => { if (selectedFile) void controller.current?.loadDiff(record.recordId, selectedFile.path) }}>重试读取</Button></div>}
        </div>
        {selectedFile && !state.diffLoading && <TurnRestoreControls key={JSON.stringify([record.recordId, selectedFile.path])} sessionId={sessionId} turnId={turnId} recordId={record.recordId} path={selectedFile.path} />}
        {state.diff && <div className="space-y-2">
          <label className="text-xs">差异布局 <select value={state.viewMode} onChange={event => setState(previous => ({ ...previous, viewMode: event.target.value === 'split' ? 'split' : 'unified' }))} className="rounded border border-border bg-background p-1">
            <option value="unified">合并</option><option value="split">左右对照</option>
          </select></label>
          {state.diff.before.content !== undefined && state.diff.after.content !== undefined
            ? <div className="max-h-[32rem] overflow-auto rounded border border-border" tabIndex={0} aria-label="文件前后差异"><DiffView oldContent={state.diff.before.content.replace(/\r\n/g, '\n')} newContent={state.diff.after.content.replace(/\r\n/g, '\n')} filePath={state.diff.path} viewMode={state.viewMode} /></div>
            : <div className="space-y-2 text-xs">
              <p>无法计算完整文本差异；下面保留可用的一侧，不以当前磁盘内容代替。</p>
              {(['before', 'after'] as const).map(side => <div key={side}><p className="font-medium">{side === 'before' ? '修改前' : '修改后'}</p>{state.diff![side].content !== undefined ? <pre tabIndex={0} className="max-h-64 overflow-auto whitespace-pre rounded bg-muted p-2">{state.diff![side].content}</pre> : <p className="text-muted-foreground">{unavailableLabel(state.diff![side])}</p>}</div>)}
            </div>}
        </div>}
      </>}
    </section>}
  </div>
}
