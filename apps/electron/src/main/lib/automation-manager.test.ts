import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Automation } from '@proma/shared'

describe('Automation 运行记录', () => {
  test('立即运行的成功与失败保留调度时间，随后定时触发推进时间', () => {
    const home = mkdtempSync(join(tmpdir(), 'proma-automation-'))
    try {
      // 配置目录和索引会在进程中缓存。独立 HOME 避免触碰用户配置和其他测试的缓存。
      const result = spawnSync(process.execPath, ['--eval', `
        import { appendRun, createAutomation, setNextRunAt } from './automation-manager'

        const task = createAutomation({
          name: '测试定时任务', prompt: '测试', scheduleType: 'interval',
          intervalMinutes: 60, channelId: 'channel', workspaceId: 'workspace',
        })
        // 设置一个固定的到期时间，便于识别任何自动重算。
        setNextRunAt(task.id, 1_000)
        appendRun(task.id, { runAt: 1_100, sessionId: 'manual', status: 'success' }, true)
        console.log(JSON.stringify([task.nextRunAt, task.runCount, task.lastRunAt, task.consecutiveFailures]))
        appendRun(task.id, { runAt: 1_200, sessionId: 'manual', status: 'error' }, true)
        // 同进程读取每次手动运行的结果，保留最终的磁盘状态供父进程复核。
        console.log(JSON.stringify([task.nextRunAt, task.runCount, task.lastRunAt, task.consecutiveFailures]))
        appendRun(task.id, { runAt: 1_300, sessionId: 'scheduled', status: 'success' })
      `], {
        cwd: import.meta.dir,
        env: { ...process.env, HOME: home, USERPROFILE: home, PROMA_DEV: '1' },
        encoding: 'utf-8',
      })
      expect(result.stderr).toBe('')
      expect(result.status).toBe(0)
      expect(result.stdout).toContain('[1000,1,1100,0]')
      expect(result.stdout).toContain('[1000,2,1200,1]')

      const index = JSON.parse(readFileSync(join(home, '.proma-dev', 'automations.json'), 'utf-8')) as {
        automations: Automation[]
      }
      const task = index.automations[0]
      expect(task?.nextRunAt).toBeGreaterThan(1_000)
      expect(task?.runCount).toBe(3)
      expect(task?.lastRunAt).toBe(1_300)
      expect(task?.consecutiveFailures).toBe(0)
      expect(task?.runHistory.map((run) => run.status)).toEqual(['success', 'error', 'success'])
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})
