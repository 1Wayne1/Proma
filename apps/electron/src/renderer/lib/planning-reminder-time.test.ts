import { expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

test('Given 夏令时跳过和重叠的墙钟时间 When 创建提醒 Then 拒绝缺口并选择较早时刻', () => {
  const path = join(import.meta.dir, 'planning-reminder-time.ts')
  const result = spawnSync(process.execPath, ['-e', `
    import assert from 'node:assert/strict'
    import { parseReminderTime, formatReminderInput } from ${JSON.stringify(path)}
    assert.throws(() => parseReminderTime('2026-03-08T02:30'), /当前时区没有/)
    const overlap = parseReminderTime('2026-11-01T01:30')
    assert.equal(overlap, Date.parse('2026-11-01T05:30:00Z'))
    assert.equal(formatReminderInput(overlap), '2026-11-01T01:30')
    process.env.TZ = 'Asia/Shanghai'
    assert.equal(formatReminderInput(overlap), '2026-11-01T13:30')
    assert.equal(parseReminderTime('2026-11-01T13:30'), overlap)
  `], { env: { ...process.env, TZ: 'America/New_York' }, encoding: 'utf8', windowsHide: true })
  expect(result.status, result.stderr).toBe(0)
})
