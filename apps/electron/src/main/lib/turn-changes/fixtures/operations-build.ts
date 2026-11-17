import { join } from 'node:path'
const outdir = process.argv[2]
if (!outdir) throw new Error('缺少夹具输出目录')
const host = join(import.meta.dir, 'operations-host.ts')
const result = await Bun.build({ entrypoints: [join(import.meta.dir, 'operations-probe.ts')], outdir, target: 'node', format: 'cjs', plugins: [{ name: 'operations-host', setup(builder) {
  builder.onResolve({ filter: /^electron$/ }, () => ({ path: host }))
  builder.onResolve({ filter: /^(?:\.\/|\.\.\/)(?:main-window-store|terminal-runtime-client|terminal-agent-policy)$/ }, () => ({ path: host }))
} }] })
if (!result.success) { for (const log of result.logs) console.error(log); process.exit(1) }
