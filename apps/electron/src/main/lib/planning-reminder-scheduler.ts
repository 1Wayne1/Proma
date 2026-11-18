/**
 * 本地任务/日程提醒调度器。
 *
 * 只在 Electron 主进程存活时运行。每条提醒在首次到期及每次推迟重新到期时各通知一次；
 * 未确认的提醒会由渲染进程从 SQLite 恢复为固定通知条。
 */

import { Notification, powerMonitor } from 'electron'
import { claimDuePlanningReminders } from './planning-manager'
import { getSettings } from './settings-service'
import { broadcastPlanningChanged, broadcastPlanningRemindersDue } from './planning-events'
import type { ActivePlanningReminder } from '@proma/shared'
import { getMainWindow } from './main-window-store'

const POLL_INTERVAL_MS = 30_000
let timer: ReturnType<typeof setInterval> | null = null
let checking = false
let lastTimeZone: string | undefined

/** 原生通知由主进程发送，窗口被隐藏或未聚焦时也不依赖渲染进程的 Web Notification。 */
function showPlanningSystemNotification(reminder: ActivePlanningReminder): void {
  if (!getSettings().notificationsEnabled || !Notification.isSupported()) return

  const notification = new Notification({
    title: reminder.targetType === 'todo' ? 'Todo 提醒' : '日程提醒',
    body: reminder.targetTitle,
    silent: true,
  })
  notification.on('click', () => {
    const window = getMainWindow()
    if (!window || window.isDestroyed()) return
    window.show()
    window.focus()
  })
  notification.show()
}

function checkDueReminders(): void {
  if (checking) return
  checking = true
  try {
    const timeZone = new Intl.DateTimeFormat().resolvedOptions().timeZone
    const timeZoneChanged = lastTimeZone !== undefined && lastTimeZone !== timeZone
    lastTimeZone = timeZone
    const reminders = claimDuePlanningReminders()
    if (reminders.length > 0) {
      broadcastPlanningRemindersDue(reminders)
      for (const reminder of reminders) {
        try { showPlanningSystemNotification(reminder) } catch (error) {
          console.warn('[任务/日程] 系统提醒发送失败:', error)
        }
      }
    }
    if (timeZoneChanged) broadcastPlanningChanged(['todos', 'calendar_events', 'reminders'])
    else if (reminders.length > 0) broadcastPlanningChanged(['reminders'])
  } catch (error) {
    console.error('[任务/日程] 检查提醒失败:', error)
  } finally {
    checking = false
  }
}

export function startPlanningReminderScheduler(): void {
  if (timer) return
  powerMonitor.on('resume', checkDueReminders)
  checkDueReminders()
  timer = setInterval(checkDueReminders, POLL_INTERVAL_MS)
}

export function stopPlanningReminderScheduler(): void {
  if (!timer) return
  clearInterval(timer)
  timer = null
  lastTimeZone = undefined
  powerMonitor.removeListener('resume', checkDueReminders)
}
