import { expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

test('Given legacy-chat main IPC 与真实 preload When 验证归属、参数、读写路径和退出清理 Then 四层契约全部通过', () => {
  const directory = mkdtempSync(join(tmpdir(), 'proma-legacy-chat-ipc-'))
  try {
    // 独立 Bun 进程隔离其它测试的 module mock 与构建缓存。
    const build = spawnSync(
      process.execPath,
      [join(import.meta.dir, 'fixtures/legacy-chat-ipc-build.ts'), directory],
      { encoding: 'utf8', timeout: 15_000, windowsHide: true },
    )
    if (build.status !== 0) console.error(build.stderr)
    expect(build.error).toBeUndefined()
    expect(build.status).toBe(0)

    const result = spawnSync('node', [join(directory, 'legacy-chat-ipc-probe.js')], {
      encoding: 'utf8',
      timeout: 15_000,
      windowsHide: true,
    })
    if (result.status !== 0) console.error(result.stderr)
    expect(result.error).toBeUndefined()
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('legacy-chat-ipc: passed')
  } finally {
    if (dirname(resolve(directory)) !== resolve(tmpdir())) throw new Error('拒绝清理临时目录之外的路径')
    rmSync(directory, { recursive: true, force: true })
  }
}, 25_000)
