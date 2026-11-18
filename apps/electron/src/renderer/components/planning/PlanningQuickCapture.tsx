import { useEffect, useId, useRef, useState } from 'react'
import { atom, useAtom } from 'jotai'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { parseReminderTime } from '@/lib/planning-reminder-time'

const quickCaptureOpenAtom = atom(false)

export function PlanningQuickCapture(): React.ReactElement {
  const [open, setOpen] = useAtom(quickCaptureOpenAtom)
  const [title, setTitle] = useState('')
  const [saving, setSaving] = useState(false)
  const busy = useRef(false)
  const timeId = useId()
  const titleId = useId()

  useEffect(() => window.electronAPI.onPlanningQuickCapture(() => setOpen(true)), [setOpen])

  const save = async (time: string): Promise<void> => {
    if (!title.trim() || busy.current) return
    busy.current = true
    setSaving(true)
    try {
      await window.electronAPI.createTodo({
        title: title.trim(),
        reminders: time ? [{ triggerAt: parseReminderTime(time) }] : undefined,
      })
      setTitle('')
      setOpen(false)
      toast.success('Todo 已添加')
    } catch (error) {
      toast.error('无法添加 Todo', { description: error instanceof Error ? error.message : String(error) })
    } finally {
      busy.current = false
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={next => { if (!busy.current) setOpen(next) }}>
      <DialogContent>
        <DialogTitle>快速记录 Todo</DialogTitle>
        <DialogDescription>可以同时设置提醒时间。</DialogDescription>
        <form className="space-y-4" onSubmit={event => {
          event.preventDefault()
          void save(String(new FormData(event.currentTarget).get('reminderTime') ?? ''))
        }}>
          <div className="space-y-1.5">
            <label htmlFor={titleId} className="text-sm font-medium">任务</label>
            <Input id={titleId} autoFocus required maxLength={500} disabled={saving} value={title} onChange={event => setTitle(event.target.value)} />
          </div>
          <div className="space-y-1.5">
            <label htmlFor={timeId} className="text-sm font-medium">提醒时间（本地时区）</label>
            <Input id={timeId} name="reminderTime" type="datetime-local" disabled={saving} />
          </div>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" disabled={saving} onClick={() => setOpen(false)}>取消</Button>
            <Button type="submit" disabled={saving || !title.trim()}>{saving ? '保存中…' : '添加 Todo'}</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
