/** 提醒保存为绝对时间。无效的本地时刻会被拒绝，夏令时重叠时选用较早的时刻。 */
export function parseReminderTime(value: string): number {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) throw new Error('请输入完整的提醒日期和时间')
  const time = new Date(value).getTime()
  if (!Number.isFinite(time) || formatReminderInput(time) !== value) {
    throw new Error('当前时区没有这个本地时间，请选择其他时刻')
  }
  return time
}

export function formatReminderInput(timestamp: number): string {
  const date = new Date(timestamp)
  const local = new Date(timestamp - date.getTimezoneOffset() * 60_000)
  return local.toISOString().slice(0, 16)
}

export function formatReminderTime(timestamp: number): string {
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZoneName: 'short',
  }).format(timestamp)
}
