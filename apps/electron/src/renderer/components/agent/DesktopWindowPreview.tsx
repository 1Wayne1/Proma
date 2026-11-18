import * as React from 'react'
import { atom, useAtom } from 'jotai'
import type { DesktopPreviewState } from '@proma/shared'
import { Button } from '@/components/ui/button'

interface PreviewView { state: DesktopPreviewState | null; png: string; error: string }
const empty: PreviewView = { state: null, png: '', error: '' }

export function DesktopWindowPreview({ sessionId }: { sessionId: string }): React.ReactElement | null {
  const local = React.useMemo(() => atom<PreviewView>(empty), [sessionId])
  const [view, setView] = useAtom(local)
  const state = view.state
  React.useEffect(() => {
    let revision = 0
    const sync = async () => {
      const current = ++revision
      try {
        const next = await window.electronAPI.desktopPreviewState(sessionId)
        if (current === revision) setView(last => ({ state: next, png: next && !next.error && next.id === last.state?.id ? last.png : '', error: '' }))
      } catch { if (current === revision) setView(empty) }
    }
    const off = window.electronAPI.onDesktopPreviewChanged(id => {
      if (id !== sessionId) return
      setView(empty)
      void sync()
    })
    void sync()
    return () => { revision++; off() }
  }, [sessionId, setView])

  const id = state?.id
  React.useEffect(() => {
    if (!id || state?.error || view.error) return
    let stopped = false
    let timer: ReturnType<typeof setTimeout>
    const pull = async () => {
      try {
        const frame = await window.electronAPI.desktopPreviewCommand({ sessionId, id, action: 'frame' })
        if (stopped) return
        if (frame?.id === id) setView(last => last.state?.id === id ? { ...last, png: frame.png } : last)
        timer = setTimeout(pull, frame?.delayMs ?? 450)
      } catch {
        if (!stopped) setView(last => last.state?.id === id ? { ...last, png: '', error: '窗口预览连接中断' } : last)
      }
    }
    void pull()
    return () => { stopped = true; clearTimeout(timer) }
  }, [sessionId, id, state?.error, view.error, setView])

  if (!state) return null
  const error = view.error || state.error
  const control = async (action: 'stop' | 'activate' | 'retry') => {
    try {
      await window.electronAPI.desktopPreviewCommand({ sessionId, id: state.id, action })
      if (action === 'retry') setView(last => last.state?.id === state.id ? { ...last, error: '' } : last)
    } catch { setView(last => last.state?.id === state.id ? { ...last, error: '窗口操作失败，请重试' } : last) }
  }
  return <section aria-label="桌面窗口预览" className="mx-3 my-1 rounded-lg border bg-card px-3 py-2 text-card-foreground">
    <div className="flex items-center gap-2 text-sm">
      <strong className="min-w-0 flex-1 truncate" title={state.title}>{state.title}</strong>
      <span className="text-xs text-muted-foreground">{state.mode === 'snapshot' ? '低频预览' : '实时预览'}</span>
      {error ? <Button size="sm" variant="outline" onClick={() => void control('retry')}>重试</Button>
        : <Button size="sm" variant="ghost" onClick={() => void control('activate')}>激活窗口</Button>}
      <Button size="sm" variant="outline" onClick={() => void control('stop')}>停止预览</Button>
    </div>
    {error ? <p role="alert" className="mt-1 text-sm text-destructive">{error}</p>
      : view.png ? <img className="mx-auto mt-2 max-h-[28vh] max-w-full object-contain" alt="所选窗口的当前画面" src={`data:image/png;base64,${view.png}`} />
        : <p role="status" className="text-xs text-muted-foreground">正在读取窗口画面…</p>}
  </section>
}
