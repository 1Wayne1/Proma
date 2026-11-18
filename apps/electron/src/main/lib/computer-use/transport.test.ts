import { expect, test } from 'bun:test'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { connectDriver } from './transport'

/** 用真实管道模拟不同的 MCP 服务端响应，不需桌面权限或安装驱动。 */
function fixture(response: string) {
  const source = `
    const { createInterface } = require('node:readline');
    createInterface({ input: process.stdin }).on('line', line => {
      const msg = JSON.parse(line);
      if (!msg.id) return;
      const reply = result => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\\n');
      if (msg.method === 'initialize') reply({ serverInfo: {name: 'cua-driver', version: '0.53.0'} });
      else { ${response} }
    });
  `
  return spawn('node', ['-e', source], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true })
}

test('等待驱动响应时撤权会拒绝请求并退出私有子进程', async () => {
  const abort = new AbortController()
  const child = fixture('')
  const stopped = once(child, 'close')
  try {
    const connection = await connectDriver(child, abort.signal)
    const pending = connection.call('list_windows', { app: '测试' })
    abort.abort()
    await expect(pending).rejects.toThrow('取消')
    await stopped
  } finally { child.kill() }
})

test('驱动发送超限的不完整消息时立即中断而非继续缓存', async () => {
  const child = fixture("process.stdout.write(Buffer.alloc(4 * 1024 * 1024, 120))")
  const stopped = once(child, 'close')
  try {
    const connection = await connectDriver(child, new AbortController().signal)
    const failure: unknown = await connection.call('get_window_state', {}).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toContain('上限')
    await stopped
  } finally { child.kill() }
})
