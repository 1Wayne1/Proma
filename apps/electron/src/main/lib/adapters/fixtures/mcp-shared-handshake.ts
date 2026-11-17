import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { PiMcpClientManager } from '../pi-mcp-tools'

/** 在 Electron 同类的 Node HTTP runtime 下验证共享握手的取消隔离。 */
async function verifySharedHandshake(): Promise<void> {
  let release!: () => void
  let observed!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const started = new Promise<void>(resolve => { observed = resolve })
  let initializes = 0
  let mutations = 0
  const server = createServer(async (request, response) => {
    if (request.method !== 'POST') {
      response.writeHead(request.method === 'DELETE' ? 200 : 405)
      response.end()
      return
    }
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const rpc = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { id?: number; method: string }
    if (rpc.method === 'initialize') {
      initializes += 1
      observed()
      await gate
      response.writeHead(200, { 'Content-Type': 'application/json', 'Mcp-Session-Id': 'fixture-1' })
      response.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: {
        protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' },
      } }))
      return
    }
    if (rpc.id === undefined) { response.writeHead(202); response.end(); return }
    mutations += 1
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: { content: [{ type: 'text', text: 'done' }] } }))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const manager = new PiMcpClientManager()
  try {
    const config = { type: 'http', url: `http://127.0.0.1:${address.port}/mcp`, startup_timeout_sec: 2 }
    const controller = new AbortController()
    const cancelled = manager.callTool('fixture', config, 'write_file', {}, controller.signal)
    const surviving = manager.callTool('fixture', config, 'write_file', {})
    await started
    controller.abort()
    await assert.rejects(cancelled, { name: 'AbortError' })
    release()
    assert.ok((await surviving).content)
    assert.equal(initializes, 1)
    assert.equal(mutations, 1)
    console.log('shared-handshake: passed')
  } finally {
    release()
    await manager.dispose()
    await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections() })
  }
}

const deadline = setTimeout(() => { console.error('共享握手验证超时'); process.exit(1) }, 10_000)
verifySharedHandshake().catch(error => { console.error(error); process.exitCode = 1 }).finally(() => clearTimeout(deadline))
