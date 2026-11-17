import { join } from 'node:path'
const host = join(import.meta.dir, 'watcher-host.ts')
const result = await Bun.build({ entrypoints: [join(import.meta.dir, 'watcher-probe.ts')], outdir: process.argv[2], target: 'node', format: 'cjs', external: ['electron'], plugins: [{ name: 'watcher-host', setup(builder) {
  builder.onResolve({ filter: /^node:fs$/ }, args => args.importer.endsWith('workspace-watcher.ts') ? { path: host } : undefined)
  builder.onResolve({ filter: /^\.\/(?:config-paths|agent-session-manager|agent-workspace-manager)$/ }, args => args.importer.endsWith('workspace-watcher.ts') ? { path: host } : undefined)
} }] })
if (!result.success) { for (const log of result.logs) console.error(log); process.exit(1) }
