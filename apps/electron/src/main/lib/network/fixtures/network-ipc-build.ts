import { join } from 'node:path'

// 构建必须离开 bun:test 进程，避免跨文件 module mock 与构建缓存污染。
const outdir = process.argv[2]
if (!outdir) throw new Error('缺少 IPC 夹具输出目录')
const stub = join(import.meta.dir, 'network-ipc-stubs.ts')
const build = await Bun.build({
  entrypoints: [join(import.meta.dir, 'network-ipc-probe.ts')], target: 'node', format: 'cjs', outdir,
  plugins: [{ name: 'network-ipc-host-fixture', setup(builder) {
    builder.onResolve({ filter: /^electron$/ }, () => ({ path: stub }))
    builder.onResolve(
      { filter: /^\.\.\/(?:channel-manager|main-window-store|proxy-fetch|proxy-settings-service|browser-controller|adapters\/pi-mcp-tools)$/ },
      args => args.importer.endsWith('network-ipc.ts') ? { path: stub } : undefined,
    )
  } }],
})
if (!build.success) {
  for (const message of build.logs) console.error(message)
  process.exit(1)
}
