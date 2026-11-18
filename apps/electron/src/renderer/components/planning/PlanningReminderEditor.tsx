import * as React from 'react'
import type { PlanningReminder, PlanningReminderTargetType } from '@proma/shared'
import { Bell, Pencil, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { formatReminderInput, formatReminderTime, parseReminderTime } from '@/lib/planning-reminder-time'

interface Props {
  targetId: string
  targetType: PlanningReminderTargetType
  reminders: PlanningReminder[]
  disabled?: boolean
}

export function PlanningReminderEditor({ targetId, targetType, reminders, disabled }: Props): React.ReactElement {
  const [draft, setDraft] = React.useState<{ value: string; reminder?: PlanningReminder }>()
  const [saving, setSaving] = React.useState(false)
  const busy = React.useRef(false)
  const labelId = React.useId()
  const pending = reminders.filter(reminder => reminder.status === 'pending')

  const change = async (operation: () => Promise<unknown>): Promise<void> => {
    if (busy.current) return
    busy.current = true
    setSaving(true)
    try {
      await operation()
      setDraft(undefined)
    } catch (error) {
      toast.error('无法更新提醒', { description: error instanceof Error ? error.message : String(error) })
    } finally {
      busy.current = false
      setSaving(false)
    }
  }

  const submit = (value: string): void => {
    if (!draft) return
    void change(async () => {
      const triggerAt = parseReminderTime(value)
      if (draft.reminder) {
        const { id, occurrenceId } = draft.reminder
        const previous = draft.reminder.snoozedUntil ?? draft.reminder.triggerAt
        if (formatReminderInput(previous) === value) return
        await window.electronAPI.updatePlanningReminder({ id, occurrenceId, triggerAt })
      } else {
        await window.electronAPI.createPlanningReminder({ targetId, targetType, triggerAt })
      }
    })
  }

  return (
    <section className="space-y-2" aria-label="提醒">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-xs font-medium text-muted-foreground">提醒</h3>
        {!draft && <Button type="button" variant="ghost" size="sm" disabled={disabled || saving} onClick={() => setDraft({ value: formatReminderInput(Date.now() + 3_600_000) })}><Bell className="size-3.5" />添加提醒</Button>}
      </div>
      {!pending.length && !draft && <p className="text-xs text-muted-foreground">没有待处理提醒</p>}
      {pending.map(reminder => (
        <div key={reminder.id} className="flex items-center justify-between gap-2 rounded-md border px-2 py-1">
          <time className="text-xs" dateTime={new Date(reminder.snoozedUntil ?? reminder.triggerAt).toISOString()}>{formatReminderTime(reminder.snoozedUntil ?? reminder.triggerAt)}</time>
          <div className="flex">
            <Button type="button" variant="ghost" size="icon" className="size-7" aria-label="编辑提醒时间" disabled={disabled || saving || !!draft} onClick={() => setDraft({ value: formatReminderInput(reminder.snoozedUntil ?? reminder.triggerAt), reminder })}><Pencil className="size-3.5" /></Button>
            <Button type="button" variant="ghost" size="icon" className="size-7" aria-label="删除提醒" disabled={disabled || saving || !!draft} onClick={() => void change(() => window.electronAPI.deletePlanningReminder({ id: reminder.id, occurrenceId: reminder.occurrenceId }))}><Trash2 className="size-3.5" /></Button>
          </div>
        </div>
      ))}
      {draft && <form className="space-y-2" onSubmit={event => {
        event.preventDefault()
        submit(String(new FormData(event.currentTarget).get('reminderTime') ?? ''))
      }}>
        <label htmlFor={labelId} className="text-xs text-muted-foreground">提醒时间（本地时区）</label>
        <Input id={labelId} name="reminderTime" type="datetime-local" required defaultValue={draft.value} disabled={saving} />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" size="sm" disabled={saving} onClick={() => setDraft(undefined)}>取消</Button>
          <Button type="submit" size="sm" disabled={saving}>{saving ? '保存中…' : '保存提醒'}</Button>
        </div>
      </form>}
    </section>
  )
}
