import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

test('Given main IPC 与真实 preload When 检查和预览导出 Then 四层契约保留权限、脱敏和原子写结果', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'proma-network-ipc-'))
  try {
    // 独立 Bun 进程隔离其它测试的 module mock 与构建缓存。
    const build = spawnSync(process.execPath, [join(import.meta.dir, 'fixtures/network-ipc-build.ts'), directory], {
      encoding: 'utf8', timeout: 15_000, windowsHide: true,
    })
    if (build.status !== 0) console.error(build.stderr)
    expect(build.error).toBeUndefined()
    expect(build.status).toBe(0)
    const artifact = { path: join(directory, 'network-ipc-probe.js') }
    const result = spawnSync('node', [artifact.path, join(directory, 'diagnostics.json')], { encoding: 'utf8', timeout: 15_000, windowsHide: true })
    if (result.status !== 0) console.error(result.stderr)
    expect(result.error).toBeUndefined()
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('network-ipc: passed')
  } finally {
    if (dirname(resolve(directory)) !== resolve(tmpdir())) throw new Error('拒绝清理临时目录之外的路径')
    rmSync(directory, { recursive: true, force: true })
  }
}, 25_000)
