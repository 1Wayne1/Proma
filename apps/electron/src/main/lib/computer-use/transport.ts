import { spawn } from 'node:child_process'
import type { ChildProcessByStdio } from 'node:child_process'
import type { Readable, Writable } from 'node:stream'
import { dirname } from 'node:path'
import { getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js'
import { DRIVER_VERSION } from './driver'

export function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export interface DriverConnection {
  call(tool: 'list_windows' | 'get_window_state' | 'click' | 'set_value', args: Record<string, unknown>): Promise<Record<string, unknown>>
  close(): void
}

/** 每次观察独占一个 MCP stdio 进程，保留快照引用；只发送固定的协议与工具。 */
export async function openDriver(file: string, signal: AbortSignal): Promise<DriverConnection> {
  signal.throwIfAborted()
  const child = spawn(file, ['mcp', '--direct'], {
    cwd: dirname(file), windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'],
    env: { ...getDefaultEnvironment(), CUA_DRIVER_RS_TELEMETRY_ENABLED: '0', DO_NOT_TRACK: '1' },
  })
  return connectDriver(child, signal)
}

export async function connectDriver(child: ChildProcessByStdio<Writable, Readable, null>, signal: AbortSignal): Promise<DriverConnection> {
  const parts: Buffer[] = []
  let bytes = 0
  let id = 0
  let closed = false
  let pending: { resolve(value: Record<string, unknown>): void; reject(error: Error): void } | undefined
  function close(reason = new Error('桌面驱动连接已结束')): void {
    if (closed) return
    closed = true
    signal.removeEventListener('abort', abort)
    pending?.reject(reason)
    pending = undefined
    child.stdin.end()
    if (child.exitCode === null && child.signalCode === null) child.kill()
    const force = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    }, 1_000)
    force.unref()
    child.once('close', () => clearTimeout(force))
    parts.length = 0
  }
  const abort = () => close(new Error('桌面操作已取消'))
  signal.addEventListener('abort', abort, { once: true })
  child.once('error', () => close(new Error('无法启动桌面驱动，请检查安装与系统授权')))
  child.stdin.on('error', () => close())
  child.once('close', () => close())
  child.stdout.on('data', (chunk: Buffer) => {
    if (closed) return
    bytes += chunk.length
    if (bytes > 3 * 1024 * 1024) return close(new Error('桌面驱动输出超过上限'))
    let start = 0
    for (let end = chunk.indexOf(10); end !== -1; end = chunk.indexOf(10, start)) {
      parts.push(chunk.subarray(start, end))
      try {
        const message: unknown = JSON.parse(Buffer.concat(parts).toString('utf8'))
        if (record(message) && message.id === id && pending) {
          if (!record(message.result)) return close(new Error('桌面驱动协议错误'))
          pending.resolve(message.result)
          pending = undefined
        }
      } catch { return close(new Error('桌面驱动返回无效 JSON')) }
      parts.length = 0
      start = end + 1
    }
    if (start < chunk.length) parts.push(chunk.subarray(start))
  })
  const request = async (method: string, params: Record<string, unknown>) => {
    if (closed || pending) throw new Error('桌面驱动不可用或仍在执行上一次请求')
    bytes = 0
    const timer = setTimeout(() => close(new Error('桌面驱动超时，请重新观察窗口后再操作')), 8_000)
    try {
      return await new Promise<Record<string, unknown>>((resolve, reject) => {
        pending = { resolve, reject }
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) + '\n')
      })
    } finally { clearTimeout(timer) }
  }
  try {
    const init = await request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'Proma', version: '1' } })
    if (!record(init.serverInfo) || init.serverInfo.name !== 'cua-driver' || init.serverInfo.version !== DRIVER_VERSION) throw new Error('桌面驱动版本不匹配')
    child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n')
  } catch (error) { close(); throw error }
  return {
    close,
    async call(tool, args) {
      const result = await request('tools/call', { name: tool, arguments: args })
      if (result.isError) {
        const block: unknown = Array.isArray(result.content) ? result.content[0] : undefined
        const text = record(block) && typeof block.text === 'string' ? block.text : ''
        if (/permission|accessibility permission|screen recording|not authorized|access denied/i.test(text)) throw new Error('系统权限不足，请检查辅助功能、屏幕录制或目标应用权限')
        if (/lock(ed)? desktop|desktop.*unavailable|screen.*locked/i.test(text)) throw new Error('当前桌面已锁定或不可用')
        if (/stale|no window|window.*not found/i.test(text)) throw new Error('目标窗口或控件引用已失效，请重新观察')
        throw new Error('驱动未确认操作成功，请重新观察窗口')
      }
      return result
    },
  }
}
