import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import type { WebContents } from 'electron'
import { isPromaSelfSearchKey, isPromaSelfSearchText } from '../../types/proma-self-control'
import { BROWSER_OBSERVE_TIMEOUT_MS, withBrowserCdpTimeout } from './browser-cdp'
import { getMainWindowRenderer } from './main-window-store'
import { assertPromaSelfExecution, isPromaSelfBounds, matchesPromaSelfControl, PROMA_SELF_CONTROL_ACTION, PROMA_SELF_CONTROLS } from './proma-self-control-policy'
import type { PromaSelfAction, PromaSelfBounds, PromaSelfControl, PromaSelfExecution } from './proma-self-control-policy'
import { buildPromaSelfScreenshot, readPromaSelfScreenshot } from './proma-self-screenshot'
import type { PromaSelfScreenshot } from './proma-self-screenshot'

const OBSERVATION_TTL_MS = 60_000
const MAX_WAIT_MS = 10_000

interface ControlReference {
  reference: string
  id: PromaSelfControl['id']
  label: PromaSelfControl['label']
  actions: PromaSelfAction['type'][]
}

interface Observation {
  generation: string
  controls: ControlReference[]
}

interface StoredObservation {
  generation: string
  sessionId: string
  expiresAt: number
  nodes: Map<string, ControlNode>
}

interface ControlNode {
  control: PromaSelfControl
  backendNodeId: number
}

interface VisibleControl extends ControlNode {
  bounds: PromaSelfBounds
}

interface SelfCdp {
  signal: AbortSignal
  send<T>(method: string, arguments_?: Record<string, unknown>): Promise<T>
}

/** 只连接应用登记的主 WebContents；任何来源都不能提交 CDP 地址、脚本或选择器。 */
export class PromaSelfController {
  private observation: StoredObservation | undefined
  private active: AbortController | undefined
  private contents: WebContents | undefined
  private untrack: (() => void) | undefined

  constructor(
    private readonly resolveWindow = getMainWindowRenderer,
    private readonly now: () => number = Date.now,
  ) {}

  observe(execution: PromaSelfExecution): Promise<Observation> {
    return this.collect(execution, '')
  }

  find(execution: PromaSelfExecution, query: string): Promise<Observation> {
    return this.collect(execution, this.normalizeQuery(query))
  }

  waitFor(execution: PromaSelfExecution, query: string, timeoutMs = 2_500): Promise<Observation> {
    const target = this.normalizeQuery(query)
    if (!target || !PROMA_SELF_CONTROLS.some(control => matchesPromaSelfControl(control, target))) throw new Error('等待目标必须匹配已授权的控件')
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_WAIT_MS) throw new Error('控件等待时长无效')
    return this.run(execution, async cdp => {
      this.observation = undefined
      const deadline = performance.now() + timeoutMs
      const contextId = await this.isolatedWorld(cdp)
      for (;;) {
        const controls = await this.scan(cdp, contextId, target)
        const remaining = deadline - performance.now()
        if (remaining <= 0) throw new Error('等待 Proma 控件超时')
        if (controls.length) return this.storeObservation(execution.sessionId, controls)
        await delay(Math.min(120, remaining), undefined, { signal: cdp.signal })
      }
    }, timeoutMs + BROWSER_OBSERVE_TIMEOUT_MS)
  }

  click(execution: PromaSelfExecution, generation: string, reference: string): Promise<void> {
    return this.act(execution, generation, reference, { type: 'click' })
  }

  fill(execution: PromaSelfExecution, generation: string, reference: string, text: string): Promise<void> {
    if (!isPromaSelfSearchText(text)) throw new Error('搜索文本须为不超过 256 字符的单行文本')
    return this.act(execution, generation, reference, { type: 'fill', value: text })
  }

  press(execution: PromaSelfExecution, generation: string, reference: string, key: string): Promise<void> {
    if (!isPromaSelfSearchKey(key)) throw new Error('只允许搜索结果导航键 ArrowUp、ArrowDown 和 Escape')
    return this.act(execution, generation, reference, { type: 'press', value: key })
  }

  scroll(execution: PromaSelfExecution, generation: string, reference: string, deltaY: number): Promise<void> {
    if (!Number.isSafeInteger(deltaY) || deltaY === 0 || Math.abs(deltaY) > 1200) throw new Error('滚动距离须为不超过 1200 像素的非零整数')
    return this.act(execution, generation, reference, { type: 'scroll', value: deltaY })
  }

  screenshot(execution: PromaSelfExecution): Promise<PromaSelfScreenshot> {
    return this.run(execution, async cdp => {
      this.observation = undefined
      const contextId = await this.isolatedWorld(cdp)
      const controls = await this.scan(cdp, contextId, '')
      const expression = buildPromaSelfScreenshot(controls.map(({ control, bounds: { x, y, width, height } }) => ({
        x, y, width, height, label: control.label, tag: control.tag,
      })))
      const { result, exceptionDetails } = await cdp.send<{ result?: { value?: unknown }; exceptionDetails?: unknown }>('Runtime.evaluate', {
        expression, contextId, returnByValue: true, silent: true,
      })
      if (exceptionDetails) throw new Error('无法生成 Proma 脱敏截图')
      return readPromaSelfScreenshot(result?.value)
    })
  }

  private normalizeQuery(query: string): string {
    if (typeof query !== 'string' || query.length > 80) throw new Error('控件查找文本无效')
    return query.trim().toLowerCase()
  }

  private act(execution: PromaSelfExecution, generation: string, reference: string, action: PromaSelfAction): Promise<void> {
    return this.run(execution, async cdp => {
      const observation = this.observation
      const node = observation?.nodes.get(reference)
      if (!observation || !node || observation.sessionId !== execution.sessionId ||
          observation.generation !== generation || observation.expiresAt <= this.now()) {
        throw new Error('控件引用已失效，请重新观察 Proma')
      }
      if (!node.control.actions.some(actionType => actionType === action.type)) throw new Error('该控件未授权执行此操作')
      // 动作发出前即销毁本次引用，避免超时或重入时重复执行。
      this.observation = undefined
      const contextId = await this.isolatedWorld(cdp)
      if (await this.inspectOrAct(cdp, contextId, node, action) !== true) {
        throw new Error('控件已变化、被遮挡或当前不可操作，请重新观察 Proma')
      }
    })
  }

  private collect(execution: PromaSelfExecution, query: string): Promise<Observation> {
    return this.run(execution, async cdp => {
      this.observation = undefined
      const contextId = await this.isolatedWorld(cdp)
      const controls = await this.scan(cdp, contextId, query)
      return this.storeObservation(execution.sessionId, controls)
    })
  }

  private storeObservation(sessionId: string, visible: VisibleControl[]): Observation {
    const generation = randomUUID()
    const nodes: StoredObservation['nodes'] = new Map()
    const controls = visible.map(({ control, backendNodeId }) => {
      const reference = randomUUID()
      nodes.set(reference, { control, backendNodeId })
      return { reference, id: control.id, label: control.label, actions: [...control.actions] }
    })
    this.observation = { generation, sessionId, expiresAt: this.now() + OBSERVATION_TTL_MS, nodes }
    return { generation, controls }
  }

  private async scan(cdp: SelfCdp, contextId: number, query: string): Promise<VisibleControl[]> {
    const { root } = await cdp.send<{ root: { nodeId: number } }>('DOM.getDocument', { depth: 0 })
    const controls: VisibleControl[] = []
    for (const control of PROMA_SELF_CONTROLS) {
      if (!matchesPromaSelfControl(control, query)) continue
      const { nodeIds } = await cdp.send<{ nodeIds: number[] }>('DOM.querySelectorAll', {
        nodeId: root.nodeId,
        selector: `${control.tag}[data-proma-self-control="${control.id}"]`,
      })
      if (nodeIds.length !== 1) continue
      const { node } = await cdp.send<{ node: { backendNodeId: number } }>('DOM.describeNode', { nodeId: nodeIds[0] })
      const target = { control, backendNodeId: node.backendNodeId }
      const bounds = await this.inspectOrAct(cdp, contextId, target)
      if (isPromaSelfBounds(bounds)) controls.push({ ...target, bounds })
    }
    return controls
  }

  private async isolatedWorld(cdp: SelfCdp): Promise<number> {
    const { frameTree } = await cdp.send<{ frameTree: { frame: { id: string } } }>('Page.getFrameTree')
    const { executionContextId } = await cdp.send<{ executionContextId: number }>('Page.createIsolatedWorld', {
      frameId: frameTree.frame.id,
      worldName: 'proma-self-control',
    })
    return executionContextId
  }

  private async inspectOrAct(cdp: SelfCdp, contextId: number, target: ControlNode, action?: PromaSelfAction): Promise<unknown> {
    const { object } = await cdp.send<{ object: { objectId?: string } }>('DOM.resolveNode', {
      backendNodeId: target.backendNodeId,
      executionContextId: contextId,
    })
    if (!object.objectId) return false
    const { result, exceptionDetails } = await cdp.send<{ result?: { value?: unknown }; exceptionDetails?: unknown }>('Runtime.callFunctionOn', {
      objectId: object.objectId,
      functionDeclaration: PROMA_SELF_CONTROL_ACTION,
      arguments: [{ value: target.control.id }, { value: target.control.tag }, { value: action ?? null }],
      returnByValue: true,
      silent: true,
    })
    return exceptionDetails ? false : result?.value
  }

  private invalidate(): void {
    this.observation = undefined
    this.active?.abort()
  }

  private track(contents: WebContents): void {
    if (this.contents === contents) return
    this.untrack?.()
    this.observation = undefined
    this.contents = contents
    const onRenderGone = (): void => this.invalidate()
    // 此处只响应主框架；工作区的 iframe 导航不会取消对主窗口的观察。
    const onMainNavigate = (details: { isMainFrame: boolean }): void => { if (details.isMainFrame) this.invalidate() }
    const onDestroyed = (): void => { this.invalidate(); this.untrack?.() }
    contents.on('did-start-navigation', onMainNavigate)
    contents.on('render-process-gone', onRenderGone)
    contents.on('destroyed', onDestroyed)
    this.untrack = () => {
      contents.removeListener('did-start-navigation', onMainNavigate)
      contents.removeListener('render-process-gone', onRenderGone)
      contents.removeListener('destroyed', onDestroyed)
      this.contents = undefined
      this.untrack = undefined
    }
  }

  private async run<T>(execution: PromaSelfExecution, operation: (cdp: SelfCdp) => Promise<T>, timeoutMs = BROWSER_OBSERVE_TIMEOUT_MS): Promise<T> {
    assertPromaSelfExecution(execution)
    if (this.active) throw new Error('Proma 界面正在执行一项操作，请稍后重试')
    const target = this.resolveWindow()
    if (!target || target.window.isDestroyed()) throw new Error('Proma 主窗口不可用')
    const contents = target.window.webContents
    const debuggerClient = contents.debugger
    const abort = new AbortController()
    const signals = [abort.signal, AbortSignal.timeout(timeoutMs)]
    if (execution.signal) signals.push(execution.signal)
    const signal = AbortSignal.any(signals)
    const assertTarget = (): void => {
      assertPromaSelfExecution(execution)
      signal.throwIfAborted()
      const current = this.resolveWindow()
      if (current?.window !== target.window || current.entryUrl !== target.entryUrl || contents.isDestroyed() ||
          contents.isLoadingMainFrame() || contents.getURL() !== target.entryUrl) {
        throw new Error('Proma 主窗口已变化或不在已登记的页面')
      }
    }
    assertTarget()
    this.track(contents)
    if (debuggerClient.isAttached()) throw new Error('Proma 主窗口的调试通道已被占用')
    this.active = abort
    let ownsDebugger = false
    const onDetach = (): void => { ownsDebugger = false; this.invalidate() }
    try {
      debuggerClient.attach('1.3')
      ownsDebugger = true
      debuggerClient.on('detach', onDetach)
      const result = await operation({
        signal,
        send: async <R,>(method: string, arguments_?: Record<string, unknown>): Promise<R> => {
          assertTarget()
          const response: unknown = await withBrowserCdpTimeout(() => {
            assertTarget()
            return debuggerClient.sendCommand(method, arguments_)
          }, method, BROWSER_OBSERVE_TIMEOUT_MS, signal)
          assertTarget()
          return response as R
        },
      })
      assertTarget()
      return result
    } catch (error) {
      this.observation = undefined
      throw error
    } finally {
      debuggerClient.removeListener('detach', onDetach)
      try { if (ownsDebugger && debuggerClient.isAttached()) debuggerClient.detach() }
      finally { this.active = undefined }
    }
  }
}

export const promaSelfController = new PromaSelfController()
