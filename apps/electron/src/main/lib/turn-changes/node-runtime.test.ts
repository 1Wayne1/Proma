import { expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

test('Given 同一逐轮服务的 Node bundle When 实际 Node 执行 Then 快照与完成状态保持一致', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'proma-turn-node-'))
  try {
    const built = await Bun.build({ entrypoints: [join(import.meta.dir, 'fixtures/node-probe.ts')], target: 'node', format: 'cjs', outdir: directory })
    expect(built.success).toBe(true)
    const artifact = built.outputs[0]
    if (!artifact) throw new Error('未生成 Node 逐轮测试入口')
    const result = spawnSync('node', [artifact.path, directory], { encoding: 'utf8', windowsHide: true, timeout: 15_000 })
    if (result.status !== 0) console.error(result.stderr)
    expect(result.error).toBeUndefined()
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('turn-changes-node: passed')
  } finally {
    if (dirname(resolve(directory)) !== resolve(tmpdir())) throw new Error('拒绝清理临时目录之外的路径')
    await rm(directory, { recursive: true, force: true })
  }
}, 20_000)
