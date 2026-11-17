import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

test('Given 真实 fs.watch 与共享目录 When 删除、切换、恢复和停止 Then 其它订阅保留且迟到自愈不复活', async () => {
  const root = await mkdtemp(join(tmpdir(), 'proma-watch-lifecycle-'))
  try {
    const build = spawnSync(process.execPath, [join(import.meta.dir, 'turn-changes/fixtures/watcher-build.ts'), root], { encoding: 'utf8', timeout: 15_000, windowsHide: true })
    if (build.status !== 0) console.error(build.stderr)
    expect(build.status).toBe(0)
    const result = spawnSync('node', [join(root, 'watcher-probe.js'), root], { encoding: 'utf8', timeout: 30_000, windowsHide: true })
    if (result.status !== 0) console.error(result.stderr)
    expect(result.error).toBeUndefined(); expect(result.status).toBe(0)
    expect(result.stdout).toContain('workspace-watch-lifecycle: passed')
  } finally {
    if (dirname(resolve(root)) !== resolve(tmpdir())) throw new Error('夹具根越界')
    await rm(root, { recursive: true, force: true })
  }
}, 50_000)
