import { expect, test } from 'bun:test'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

test('Given 本地预览会话 When 请求同级资源、切换会话、替换入口和撤销 Then 文件能力仅在本次预览内有效', async () => {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'proma-browser-preview-'))
  try {
    const entry = join(dir, 'entry.ts')
    writeFileSync(entry, [
      `export { createAuthorizedPreviewUrl } from ${JSON.stringify(join(import.meta.dir, 'browser-preview-service.ts'))}`,
      `export { handlePromaFileRequest } from ${JSON.stringify(join(import.meta.dir, 'local-file-protocol.ts'))}`,
    ].join('\n'))
    const result = await Bun.build({ entrypoints: [entry], target: 'node', format: 'cjs', outdir: dir, external: ['electron'] })
    expect(result.success).toBe(true)
    const probe = spawnSync('node', ['-e', `
const assert = require('node:assert/strict')
const { mkdirSync, renameSync, symlinkSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')
const Module = require('node:module')
const original = Module._load
Module._load = function(name, ...args) {
  if (name === 'electron') return { net: { fetch: () => new Response('ok') } }
  return original.call(this, name, ...args)
}
const { createAuthorizedPreviewUrl, handlePromaFileRequest } = require(join(process.argv[1], 'entry.js'))
const root = join(process.argv[1], 'project')
const outside = join(process.argv[1], 'outside')
mkdirSync(root)
mkdirSync(outside)
writeFileSync(join(root, 'index.html'), '<p>ok</p>')
writeFileSync(join(root, 'style.css'), 'p{}')
writeFileSync(join(outside, 'outside.html'), '<p>outside</p>')
symlinkSync(outside, join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
const scope = {}
assert.throws(() => createAuthorizedPreviewUrl('linked/outside.html', [root], root, scope), /授权/)
const preview = createAuthorizedPreviewUrl(root, [root], root, scope)
const request = new Request(preview.url)
const css = new Request(preview.url.replace('index.html', 'style.css'))
assert.equal(handlePromaFileRequest(request, scope).status, 200)
assert.equal(handlePromaFileRequest(css, scope).status, 200)
assert.equal(handlePromaFileRequest(request, {}).status, 404)
assert.equal(handlePromaFileRequest(new Request(preview.url.replace('index.html','linked/outside.html')), scope).status, 403)
renameSync(join(root, 'index.html'), join(root, 'old.html'))
writeFileSync(join(root, 'index.html'), '<p>replaced</p>')
assert.throws(() => preview.verify(), /已被替换/)
assert.equal(handlePromaFileRequest(request, scope).status, 404)
const fresh = createAuthorizedPreviewUrl(root, [root], root, scope)
fresh.release()
assert.equal(handlePromaFileRequest(new Request(fresh.url), scope).status, 404)
`, dir], { encoding: 'utf8', timeout: 10_000 })
    if (probe.status !== 0) console.error(probe.stderr)
    expect(probe.status).toBe(0)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
