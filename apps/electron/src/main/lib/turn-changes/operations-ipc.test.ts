import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

test('Given 实际 main/preload、恢复服务和 terminal-service When 确认或失效 Then 归属、主 frame 和资源释放契约贯通', async () => {
  const root = await mkdtemp(join(tmpdir(), 'proma-turn-operations-ipc-'))
  try {
    const build = spawnSync(process.execPath, [join(import.meta.dir, 'fixtures/operations-build.ts'), root], { encoding: 'utf8', timeout: 15_000, windowsHide: true })
    if (build.status !== 0) console.error(build.stderr)
    expect(build.error).toBeUndefined(); expect(build.status).toBe(0)
    const result = spawnSync('node', [join(root, 'operations-probe.js'), root], { encoding: 'utf8', timeout: 30_000, windowsHide: true })
    if (result.status !== 0) console.error(result.stderr)
    expect(result.error).toBeUndefined(); expect(result.status).toBe(0)
    expect(result.stdout).toContain('turn-operations-ipc: passed')
  } finally {
    if (dirname(resolve(root)) !== resolve(tmpdir())) throw new Error('夹具目录越界')
    await rm(root, { recursive: true, force: true })
  }
}, 50_000)
