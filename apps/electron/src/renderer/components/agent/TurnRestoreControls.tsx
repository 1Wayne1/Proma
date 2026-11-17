import * as React from 'react'
import { useAtom } from 'jotai'
import { createTurnRestoreAtom, createTurnRestoreController } from '@/atoms/turn-restore-atoms'
import { Button } from '@/components/ui/button'
import { DiffView } from '@/components/diff/DiffView'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog'
import type { TurnFileDiffQuery } from '@proma/shared'

export function TurnRestoreControls(file: TurnFileDiffQuery): React.ReactElement {
  const stateAtom = React.useMemo(createTurnRestoreAtom, [file.sessionId, file.turnId, file.recordId, file.path])
  const [state, setState] = useAtom(stateAtom)
  const controller = React.useRef<ReturnType<typeof createTurnRestoreController> | null>(null)
  React.useEffect(() => {
    const current = createTurnRestoreController(window.electronAPI, file, patch => setState(previous => ({ ...previous, ...patch })))
    controller.current = current
    return () => { current.dispose(); if (controller.current === current) controller.current = null }
  }, [file.sessionId, file.turnId, file.recordId, file.path, setState])
  const previewButton = React.useRef<HTMLButtonElement>(null)
  const preview = state.preview
  return <div className="space-y-2 border-t border-border pt-2">
    <Button ref={previewButton} variant="outline" size="sm" disabled={state.pending !== null} onClick={() => { void controller.current?.preview() }}>预览恢复此文件</Button>
    <p className="text-xs text-muted-foreground">恢复到本次执行开始前的快照。仅处理此文件；有后续编辑时会拒绝恢复。</p>
    <div role="status" aria-live="polite" className="text-xs">
      {state.pending === 'preview' && <p>正在核对当前文件并准备恢复预览…</p>}
      {state.error && <p className="text-destructive">{state.error}</p>}
      {preview && preview.status !== 'ready' && <p>{preview.reason}</p>}
      {state.result && <p className={state.result.status === 'restored' ? '' : 'text-destructive'}>{state.result.status === 'restored' ? `已恢复 ${state.result.path}。暂存区与其它文件保持原状态。` : state.result.reason}</p>}
    </div>
    <AlertDialog open={preview?.status === 'ready'} onOpenChange={open => { if (!open) controller.current?.cancel() }}>
      <AlertDialogContent onCloseAutoFocus={event => { event.preventDefault(); previewButton.current?.focus() }} className="max-h-[85vh] w-[calc(100%_-_2rem)] max-w-3xl overflow-y-auto" onEscapeKeyDown={event => { if (state.pending === 'apply') event.preventDefault() }}>
        <AlertDialogHeader>
          <AlertDialogTitle>{preview?.action === 'delete' ? '确认删除本轮新增文件' : '确认恢复文件'}</AlertDialogTitle>
          <AlertDialogDescription className="break-all">{file.path}。将当前文件恢复为轮初快照；下方显示恢复前后的差异。预览有效期为 60 秒；应用前再次核对文件和项目身份。</AlertDialogDescription>
        </AlertDialogHeader>
        {preview?.source === 'git-observed' && <p className="text-xs text-muted-foreground">此变化由 Git 观察到，可能包含用户或其它程序的修改。</p>}
        {preview?.action === 'delete' && <p className="text-sm text-destructive">此文件在轮初不存在，确认后将删除当前文件。</p>}
        {preview?.diff && (preview.diff.before.content !== undefined && preview.diff.after.content !== undefined
          ? <div tabIndex={0} aria-label="恢复预览差异" className="max-h-80 overflow-auto rounded border border-border"><DiffView oldContent={preview.diff.before.content.replace(/\r\n/g, '\n')} newContent={preview.diff.after.content.replace(/\r\n/g, '\n')} filePath={file.path} viewMode="unified" /></div>
          : <p className="text-sm text-muted-foreground">二进制文件不显示文本差异。恢复将使用完整原始字节快照（{preview.diff.after.snapshot.byteLength ?? 0} 字节）。</p>)}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={state.pending === 'apply'}>取消</AlertDialogCancel>
          <AlertDialogAction disabled={state.pending !== null} onClick={event => { event.preventDefault(); void controller.current?.apply() }}>{state.pending === 'apply' ? '正在恢复…' : preview?.action === 'delete' ? '确认删除文件' : '确认恢复'}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </div>
}
