import { Type } from 'typebox'
import { Check } from 'typebox/value'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import { driverLocation, verifyDriver } from '../computer-use/driver'
import { openDriver } from '../computer-use/transport'
import type { DriverConnection } from '../computer-use/transport'
import { DesktopWindowSession } from '../computer-use/window-session'
import type { WindowConsent } from '../computer-use/window-session'
import type { PromaSelfForegroundAccess } from '../proma-self-access'
import { desktopPreviews } from '../computer-use/preview-runtime'
import { getMainWindow } from '../main-window-store'

function display(text: string): string {
  return text.replace(/[\p{Cc}\p{Cf}]/gu, ' ').slice(0, 220)
}
async function prompt(message: string, detail: string, buttons: string[], signal: AbortSignal) {
  const { dialog } = await import('electron')
  const parent = getMainWindow()
  signal.throwIfAborted()
  if (!parent || !parent.isVisible()) throw new Error('当前没有可授权的 Proma 主窗口')
  const { response } = await dialog.showMessageBox(parent, { type: 'question', title: 'Proma 桌面操作', message, detail,
    buttons: ['取消', ...buttons], defaultId: 0, cancelId: 0, noLink: true, signal })
  signal.throwIfAborted()
  return response
}
const consent: WindowConsent = {
  async choose(windows, screenshot, signal, preview) {
    const response = await prompt('选择允许 Agent 观察的窗口', (screenshot ? '窗口控件和截图将发送给本轮模型并保存在会话中。' : '窗口控件标签将发送给本轮模型并保存在会话中。') + (preview ? ' 同时在当前会话持续预览此窗口，可随时停止。' : ''),
      windows.map((w, i) => `${i + 1}. ${display(w.app)} · ${display(w.title)} (PID ${w.pid})`), signal)
    return windows[response - 1]
  },
  async confirm(target, element, value, signal) {
    return await prompt(value === undefined ? '允许点击这个控件？' : '允许填写这个控件？',
      `${display(target.app)} · ${display(target.title)} (PID ${target.pid})\n${display(element.role)} · ${display(element.label)}${value !== undefined ? `\n填写内容：${value}` : ''}`,
      ['允许本次操作'], signal) === 1
  },
}
const observeParams = Type.Object({ app: Type.String({ minLength: 1, maxLength: 100 }), screenshot: Type.Optional(Type.Boolean()), preview: Type.Optional(Type.Boolean()) }, { additionalProperties: false })
const actionParams = Type.Object({
  reference: Type.String({ pattern: '^[a-f0-9-]{36}$' }),
  value: Type.Optional(Type.Union([
    Type.Null(),
    Type.String({ maxLength: 512, pattern: '^[^\\x00-\\x1f\\x7f\\u202a-\\u202e\\u2066-\\u2069]*$' }),
  ], { description: '点击时传 null，填写时传文本，空字符串表示清空。' })),
}, { additionalProperties: false })

interface DesktopRuntime {
  connect(signal: AbortSignal): Promise<DriverConnection>
  consent: WindowConsent
}

function installedDesktopRuntime(): DesktopRuntime | undefined {
  const location = driverLocation(process.platform, process.arch)
  if (location) return {
    connect: async signal => openDriver(await verifyDriver(location, signal), signal),
    consent,
  }
}

export function buildPiDesktopWindowTools(access: (PromaSelfForegroundAccess & { sessionId?: string }) | undefined, runtime = installedDesktopRuntime()): ToolDefinition[] {
  if (!runtime || !access?.isCurrent() || access.signal.aborted) return []
  const lifetime = access.signal
  let connection: DriverConnection | undefined
  let stopPreview: (() => void) | undefined
  let session: DesktopWindowSession | undefined
  let idle: ReturnType<typeof setTimeout> | undefined
  let active = false
  function release() {
    clearTimeout(idle)
    connection?.close()
    connection = undefined
    session = undefined
  }
  lifetime.addEventListener('abort', release, { once: true })
  const check = () => {
    if (lifetime.aborted || !access.isCurrent()) throw new Error('当前运行没有桌面操作权限')
  }
  async function execute<T>(signal: AbortSignal | undefined, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
    check()
    if (active) throw new Error('请等待当前桌面操作结束')
    active = true
    clearTimeout(idle)
    const combined = signal ? AbortSignal.any([lifetime, signal]) : lifetime
    combined.addEventListener('abort', release, { once: true })
    try {
      combined.throwIfAborted()
      const result = await fn(combined)
      combined.throwIfAborted()
      check()
      return result
    } catch (error) { release(); throw error }
    finally {
      active = false
      combined.removeEventListener('abort', release)
      if (connection) idle = setTimeout(release, 60_000)
    }
  }
  return [{
    name: 'DesktopWindowObserve', label: '观察桌面窗口', description: '按应用名称查找窗口，用户选择后返回控件及一次性引用。向用户展示实时预览时传 preview=true，需要向模型交付单帧时传 screenshot=true。', parameters: observeParams,
    execute: (_id, args, signal) => execute(signal, async current => {
      if (!Check(observeParams, args) || !args.app.trim()) throw new Error('请指定应用名称')
      stopPreview?.()
      release()
      connection = await runtime.connect(current)
      current.throwIfAborted()
      check()
      session = new DesktopWindowSession(connection, runtime.consent, check)
      const { image, ...result } = await session.observe(args.app.trim(), args.screenshot === true, current, args.preview === true)
      if (args.preview && access.sessionId) {
        check()
        stopPreview = desktopPreviews.bind(access.sessionId, `${result.window.app} · ${result.window.title}`, session.previewSource(runtime.connect), lifetime, access.isCurrent)
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }, ...(image ? [{ type: 'image' as const, mimeType: 'image/png', data: image }] : [])], details: {} }
    }),
  }, {
    name: 'DesktopWindowAct', label: '操作桌面控件', description: '使用刚观察到的控件引用。点击时传 value: null，填写时传文本，空字符串表示清空。每次需用户确认，操作后重新观察。', parameters: actionParams,
    execute: (_id, args, signal) => execute(signal, async current => {
      if (!Check(actionParams, args) || !session) throw new Error('请先观察目标窗口并使用当前引用')
      await session.act(args.reference, args.value ?? undefined, current)
      release()
      return { content: [{ type: 'text' as const, text: '已提交操作，请重新观察以确认结果。' }], details: {} }
    }),
  }]
}
