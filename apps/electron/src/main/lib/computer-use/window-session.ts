import { randomUUID } from 'node:crypto'
import { record } from './transport'
import type { PreviewSource } from './preview'
import type { DriverConnection } from './transport'

export interface DesktopWindow { pid: number; id: number; app: string; title: string }
interface Element { reference: string; role: string; label: string }
export interface WindowConsent {
  choose(windows: DesktopWindow[], screenshot: boolean, signal: AbortSignal, preview?: boolean): Promise<DesktopWindow | undefined>
  confirm(target: DesktopWindow, element: Element, value: string | undefined, signal: AbortSignal): Promise<boolean>
}
interface Snapshot {
  window: DesktopWindow
  controls: Map<string, { element: Element; token: string }>
  expires: number
}

function positiveId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function windows(result: Record<string, unknown>): DesktopWindow[] {
  const data = result.structuredContent
  if (!record(data) || !Array.isArray(data.windows)) throw new Error('窗口列表格式无效')
  return data.windows.flatMap((row: unknown) => {
    if (!record(row) || !positiveId(row.pid) || !positiveId(row.window_id) || row.pid === process.pid ||
        typeof row.app_name !== 'string' || typeof row.title !== 'string' || row.is_on_screen === false || row.minimized === true) return []
    return [{ pid: row.pid, id: row.window_id, app: row.app_name, title: row.title }]
  })
}

function identity(target: DesktopWindow, other: DesktopWindow): boolean {
  return target.pid === other.pid && target.id === other.id && target.app === other.app && target.title === other.title
}

function decodeImage(result: Record<string, unknown>): string {
  const image: unknown = Array.isArray(result.content) && result.content.find((item: unknown) => record(item) && item.type === 'image')
  if (!record(image) || image.mimeType !== 'image/png' || typeof image.data !== 'string' || image.data.length > 2_000_000 || !image.data.startsWith('iVBORw0KGgo')) throw new Error('窗口截图不可用，请检查屏幕录制权限')
  return image.data
}

/** 运行私有的一次性操作引用。驱动返回的令牌只保存在主进程。 */
export class DesktopWindowSession {
  private readonly session = randomUUID()
  private snapshot?: Snapshot
  constructor(private readonly connection: DriverConnection, private readonly consent: WindowConsent, private readonly check: () => void, private readonly platform: NodeJS.Platform = process.platform) {}

  private checkAccess(signal: AbortSignal): void {
    signal.throwIfAborted()
    this.check()
  }

  private async verify(target: DesktopWindow, signal: AbortSignal): Promise<void> {
    this.checkAccess(signal)
    const current = windows(await this.connection.call('list_windows', { pid: target.pid, on_screen_only: true, session: this.session }))
    if (!current.some(w => identity(w, target))) throw new Error('窗口身份已变化，请重新选择')
    this.checkAccess(signal)
  }

  async observe(app: string, screenshot: boolean, signal: AbortSignal, preview = false) {
    this.snapshot = undefined
    this.checkAccess(signal)
    const candidates = windows(await this.connection.call('list_windows', { app, on_screen_only: true, session: this.session })).slice(0, 6)
    if (!candidates.length) throw new Error('没有找到匹配的可见窗口')
    this.checkAccess(signal)
    const target = await this.consent.choose(candidates, screenshot, signal, preview)
    if (!target || !candidates.includes(target)) throw new Error('用户取消了窗口选择')
    await this.verify(target, signal)
    this.checkAccess(signal)
    const result = await this.connection.call('get_window_state', { pid: target.pid, window_id: target.id, session: this.session,
      tree_format: 'elements', max_elements: 80, include_screenshot: screenshot, ...(screenshot ? { max_image_dimension: 960 } : {}) })
    this.checkAccess(signal)
    const data = result.structuredContent
    if (!record(data) || data.pid !== target.pid || data.window_id !== target.id ||
        (typeof data.window_title === 'string' && data.window_title !== target.title) ||
        !Array.isArray(data.elements) || typeof data.snapshot_id !== 'string' || !/^s[0-9a-f]{8}$/.test(data.snapshot_id)) throw new Error('窗口快照与选中目标不一致')
    const controls: Snapshot['controls'] = new Map()
    const elements: Element[] = []
    for (const row of data.elements.slice(0, 80)) {
      if (!record(row) || typeof row.role !== 'string') continue
      const role = row.role.slice(0, 80)
      const label = [row.title, row.name, row.label, row.description].find((v): v is string => typeof v === 'string' && !!v)?.slice(0, 180) ?? ''
      const token = row.element_token
      const actionable = typeof token === 'string' && /^s[0-9a-f]{8}:\d{1,6}$/.test(token) && token.startsWith(`${data.snapshot_id}:`)
      const element = { reference: actionable ? randomUUID() : '', role, label }
      if (actionable) controls.set(element.reference, { element, token })
      elements.push(element)
    }
    const image = screenshot ? decodeImage(result) : undefined
    this.snapshot = { window: target, controls, expires: Date.now() + 60_000 }
    return { window: { app: target.app, title: target.title }, elements, image }
  }

  /** 显示帧使用独立驱动连接，保持用户选中的快照和操作令牌有效。 */
  previewSource(connect: (signal: AbortSignal) => Promise<DriverConnection>): PreviewSource {
    const target = this.snapshot?.window
    if (!target) throw new Error('请先选择预览窗口')
    // macOS 代理同时管理两个 stdio 连接，同一驱动会话不能跨连接使用。
    const previewSession = randomUUID()
    const args = { pid: target.pid, window_id: target.id, session: previewSession }
    let connection: DriverConnection | undefined
    const withTarget = async (signal: AbortSignal) => {
      this.checkAccess(signal)
      connection ??= await connect(signal)
      this.checkAccess(signal)
      const candidates = windows(await connection.call('list_windows', { pid: target.pid, on_screen_only: true, session: previewSession }))
      this.checkAccess(signal)
      if (!candidates.some(window => identity(window, target))) throw new Error('目标窗口已关闭或发生变化，请重新选择')
      return { driver: connection, args }
    }
    return {
      capture: async (signal, lowFrequency) => {
        const { driver, args } = await withTarget(signal)
        const result = await driver.call('get_window_state', { ...args, display_only: true, include_accessibility_tree: false,
          include_screenshot: true, max_image_dimension: lowFrequency ? 640 : 960 })
        this.checkAccess(signal)
        const data = result.structuredContent
        if (!record(data) || data.pid !== target.pid || data.window_id !== target.id ||
            (typeof data.window_title === 'string' && data.window_title !== target.title)) throw new Error('预览帧来自其他窗口')
        return decodeImage(result)
      },
      activate: async signal => {
        const { driver, args } = await withTarget(signal)
        const result = await driver.call('bring_to_front', args)
        if (record(result.structuredContent) && result.structuredContent.activated === false) throw new Error('目标窗口尚未激活')
        this.checkAccess(signal)
      },
      close() { connection?.close(); connection = undefined },
    }
  }

  async act(reference: string, value: string | undefined, signal: AbortSignal): Promise<void> {
    this.checkAccess(signal)
    const snapshot = this.snapshot
    this.snapshot = undefined
    const control = snapshot?.controls.get(reference)
    if (!snapshot || !control || Date.now() >= snapshot.expires) throw new Error('控件引用已失效，请重新观察')
    if (value !== undefined && /^(AX)?Button$/i.test(control.element.role)) throw new Error('按钮只支持点击，请重新观察并将 value 设为 null')
    if (!await this.consent.confirm(snapshot.window, control.element, value, signal)) throw new Error('用户取消了桌面操作')
    await this.verify(snapshot.window, signal)
    this.checkAccess(signal)
    if (Date.now() >= snapshot.expires) throw new Error('控件引用已过期，请重新观察')
    const args = { pid: snapshot.window.pid, window_id: snapshot.window.id, element_token: control.token, session: this.session }
    if (value === undefined) await this.connection.call('click', { ...args, delivery_mode: 'background' })
    else await this.connection.call('set_value', { ...args, value, ...(this.platform === 'win32' ? { delivery_mode: 'background' } : {}) })
    this.checkAccess(signal)
  }
}
