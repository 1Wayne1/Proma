import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

test('Given 实际 utility facade、main IPC 与 preload When 工具获准并写入 Then 分轮记录与只读查询契约贯通', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'proma-turn-ipc-'))
  const host = join(import.meta.dir, 'fixtures/ipc-host.ts')
  try {
    const built = await Bun.build({ entrypoints: [join(import.meta.dir, 'fixtures/ipc-probe.ts')], outdir: directory, target: 'node', format: 'cjs', plugins: [{ name: 'turn-host-fixture', setup(builder) {
      builder.onResolve({ filter: /^electron$/ }, () => ({ path: host }))
      builder.onResolve({ filter: /^\.\.\/(?:main-window-store|agent-session-manager|agent-workspace-manager)$/ }, args => args.importer.endsWith('turn-changes/ipc.ts') || args.importer.endsWith('turn-changes\\ipc.ts') ? { path: host } : undefined)
      builder.onResolve({ filter: /^\.\.\/config-paths$/ }, args => /turn-changes[\\/]service\.ts$/.test(args.importer) ? { path: host } : undefined)
      builder.onResolve({ filter: /^\.\.\/agent-runtime-client$/ }, args => args.importer.endsWith('pi-utility-adapter.ts') ? { path: host } : undefined)
    } }] })
    expect(built.success).toBe(true)
    const artifact = built.outputs[0]
    if (!artifact) throw new Error('IPC fixture 未生成')
    const result = spawnSync('node', [artifact.path, directory], { encoding: 'utf8', timeout: 20_000, windowsHide: true })
    if (result.status !== 0) console.error(result.stderr)
    expect(result.error).toBeUndefined()
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('turn-changes-ipc: passed')
  } finally {
    if (dirname(resolve(directory)) !== resolve(tmpdir())) throw new Error('临时根越界')
    await rm(directory, { recursive: true, force: true })
  }
}, 25_000)
