import { describe, expect, test } from 'bun:test'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { McpToolResultUncertainError, PiMcpClientManager } from './pi-mcp-tools'

interface RpcRequest {
  jsonrpc: string
  id?: number | string
  method: string
}

interface FixtureOptions {
  rejectFirstDiscovery?: boolean
  rejectFirstMutation?: boolean
  initializationGate?: Promise<void>
  onInitialize?: () => void
}

async function createMcpFixture(options: FixtureOptions = {}) {
  const counts = { initializes: 0, discoveries: 0, mutations: 0 }
  const server = createServer(async (request, response) => {
      const send = (status: number, value?: unknown, headers: Record<string, string> = {}): void => {
        response.writeHead(status, { 'Content-Type': 'application/json', ...headers })
        response.end(value === undefined ? undefined : JSON.stringify(value))
      }
      if (request.method === 'DELETE') { send(200); return }
      if (request.method !== 'POST') { send(405); return }
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      const rpc = JSON.parse(Buffer.concat(chunks).toString('utf8')) as RpcRequest
      if (rpc.method === 'initialize') {
        counts.initializes += 1
        options.onInitialize?.()
        await options.initializationGate
        send(200, { jsonrpc: '2.0', id: rpc.id, result: {
          protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' },
        } }, { 'Mcp-Session-Id': `fixture-${counts.initializes}` })
        return
      }
      if (rpc.id === undefined) { send(202); return }
      if (rpc.method === 'tools/list') {
        counts.discoveries += 1
        if (options.rejectFirstDiscovery && counts.discoveries === 1) { send(503, { error: 'unavailable' }); return }
        send(200, { jsonrpc: '2.0', id: rpc.id, result: { tools: [{ name: 'write_file', inputSchema: { type: 'object' } }] } })
        return
      }
      if (rpc.method === 'tools/call') {
        counts.mutations += 1
        if (options.rejectFirstMutation && counts.mutations === 1) { send(404, { error: 'Session expired' }); return }
        send(200, { jsonrpc: '2.0', id: rpc.id, result: { content: [{ type: 'text', text: 'done' }] } })
        return
      }
      send(404)
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('fixture 未获得监听端口')
  const close = async (): Promise<void> => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve())
      server.closeAllConnections()
    })
  }
  return { counts, close, config: { type: 'http', url: `http://127.0.0.1:${address.port}/mcp`, startup_timeout_sec: 2 } }
}

describe('MCP 连接恢复与工具重放边界', () => {
  test('Given 工具发现返回 503 When 只读恢复 Then 重新握手后发现工具', async () => {
    const fixture = await createMcpFixture({ rejectFirstDiscovery: true })
    const manager = new PiMcpClientManager()
    try {
      expect((await manager.listTools('fixture', fixture.config))[0]?.name).toBe('write_file')
      expect(fixture.counts.discoveries).toBe(2)
      expect(fixture.counts.initializes).toBe(2)
      expect(fixture.counts.mutations).toBe(0)
    } finally {
      await manager.dispose()
      await fixture.close()
    }
  })

  test('Given 写入工具收到 Session 404 When 连接失效 Then 不重放并等待调用方核实结果', async () => {
    const fixture = await createMcpFixture({ rejectFirstMutation: true })
    const manager = new PiMcpClientManager()
    try {
      await expect(manager.callTool('fixture', fixture.config, 'write_file', {})).rejects.toBeInstanceOf(McpToolResultUncertainError)
      expect(fixture.counts.mutations).toBe(1)
      expect(fixture.counts.initializes).toBe(1)
      // 后续显式调用可以新建连接；原调用没有隐式重放。
      await manager.callTool('fixture', fixture.config, 'write_file', {})
      expect(fixture.counts.mutations).toBe(2)
      expect(fixture.counts.initializes).toBe(2)
    } finally {
      await manager.dispose()
      await fixture.close()
    }
  })

  test('Given 调用前已取消 When 请求工具 Then 不创建连接或发送动作', async () => {
    const fixture = await createMcpFixture()
    const manager = new PiMcpClientManager()
    const controller = new AbortController()
    controller.abort()
    try {
      await expect(manager.callTool('fixture', fixture.config, 'write_file', {}, controller.signal)).rejects.toHaveProperty('name', 'AbortError')
      expect(fixture.counts.initializes).toBe(0)
      expect(fixture.counts.mutations).toBe(0)
    } finally {
      await manager.dispose()
      await fixture.close()
    }
  })

  test('Given 等待握手时取消 When 迟到握手成功 Then 不发送工具动作', async () => {
    let finishInitialization!: () => void
    let markInitialized!: () => void
    const initializationGate = new Promise<void>(resolve => { finishInitialization = resolve })
    const started = new Promise<void>(resolve => { markInitialized = resolve })
    const fixture = await createMcpFixture({ initializationGate, onInitialize: markInitialized })
    const manager = new PiMcpClientManager()
    const controller = new AbortController()
    try {
      const operation = manager.callTool('fixture', fixture.config, 'write_file', {}, controller.signal)
      await started
      controller.abort()
      finishInitialization()
      await expect(operation).rejects.toHaveProperty('name', 'AbortError')
      expect(fixture.counts.mutations).toBe(0)
    } finally {
      finishInitialization()
      await manager.dispose()
      await fixture.close()
    }
  })

  test('Given 等待握手时销毁 manager When 迟到握手成功 Then 旧生命周期不发送工具动作', async () => {
    let finishInitialization!: () => void
    let markInitialized!: () => void
    const initializationGate = new Promise<void>(resolve => { finishInitialization = resolve })
    const started = new Promise<void>(resolve => { markInitialized = resolve })
    const fixture = await createMcpFixture({ initializationGate, onInitialize: markInitialized })
    const manager = new PiMcpClientManager()
    try {
      const operation = manager.callTool('fixture', fixture.config, 'write_file', {})
      await started
      const disposed = manager.dispose()
      finishInitialization()
      await expect(operation).rejects.toHaveProperty('name', 'AbortError')
      await disposed
      expect(fixture.counts.mutations).toBe(0)
    } finally {
      finishInitialization()
      await manager.dispose()
      await fixture.close()
    }
  })

  test('Given Node 中两个调用共享握手 When 一个等待者取消 Then 另一个调用仍完成且不重复握手', async () => {
    // Bun 1.3.6 的延迟 HTTP 响应在此并发场景停滞；用真实 Node 执行同一 manager。
    const directory = mkdtempSync(join(tmpdir(), 'proma-mcp-recovery-'))
    try {
      const build = await Bun.build({
        entrypoints: [join(import.meta.dir, 'fixtures/mcp-shared-handshake.ts')],
        target: 'node', format: 'cjs', outdir: directory,
      })
      expect(build.success).toBe(true)
      const artifact = build.outputs[0]
      if (!artifact) throw new Error('未生成 Node 验证脚本')
      const result = spawnSync('node', [artifact.path], { encoding: 'utf8', timeout: 12_000, windowsHide: true })
      expect(result.error).toBeUndefined()
      expect(result.status).toBe(0)
      expect(result.stdout).toContain('shared-handshake: passed')
    } finally {
      if (dirname(resolve(directory)) !== resolve(tmpdir())) throw new Error('拒绝清理临时目录之外的路径')
      rmSync(directory, { recursive: true, force: true })
    }
  }, 20_000)
})
