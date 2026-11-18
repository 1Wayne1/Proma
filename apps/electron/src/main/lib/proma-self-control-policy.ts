import { PROMA_SELF_FILE_SEARCH, PROMA_SELF_SEARCH_FILL_EVENT, PROMA_SELF_SEARCH_PRESS_EVENT } from '../../types/proma-self-control'
import type { PromaSelfSearchKey } from '../../types/proma-self-control'

export interface PromaSelfExecution {
  sessionId: string
  source: 'user' | 'automation' | 'delegation' | 'external'
  isCurrent: () => boolean
  signal?: AbortSignal
}

/** 仅暴露明确绑定的无持久化副作用控件，输出标签不读取 DOM 文本。 */
export const PROMA_SELF_CONTROLS = [
  { id: 'open-todos', label: 'Todo', tag: 'button', actions: ['click'] },
  { id: 'open-calendar', label: '日程', tag: 'button', actions: ['click'] },
  { id: PROMA_SELF_FILE_SEARCH, label: '搜索文件', tag: 'input', actions: ['fill', 'press'] },
  { id: 'scroll-project-files', label: '滚动项目文件', tag: 'div', actions: ['scroll'] },
  { id: 'scroll-session-files', label: '滚动会话文件', tag: 'div', actions: ['scroll'] },
] as const

export type PromaSelfControl = typeof PROMA_SELF_CONTROLS[number]
export type PromaSelfAction =
  | { type: 'click' }
  | { type: 'fill'; value: string }
  | { type: 'press'; value: PromaSelfSearchKey }
  | { type: 'scroll'; value: number }

export interface PromaSelfBounds {
  x: number
  y: number
  width: number
  height: number
}

export function isPromaSelfBounds(value: unknown): value is PromaSelfBounds {
  if (!value || typeof value !== 'object') return false
  const { x, y, width, height } = value as Partial<PromaSelfBounds>
  return [x, y, width, height].every(item => typeof item === 'number' && Number.isFinite(item)) &&
    typeof width === 'number' && width > 0 && typeof height === 'number' && height > 0
}

export function matchesPromaSelfControl(control: PromaSelfControl, query: string): boolean {
  return !query || control.label.toLowerCase().includes(query) || control.id.includes(query)
}

export function assertPromaSelfExecution(execution: PromaSelfExecution): void {
  if (execution.source !== 'user' || typeof execution.sessionId !== 'string' || !execution.sessionId || execution.sessionId.length > 256) {
    throw new Error('自身界面操作仅供当前用户交互会话使用')
  }
  execution.signal?.throwIfAborted()
  if (!execution.isCurrent()) throw new DOMException('当前会话已结束或切换', 'AbortError')
}

/** 固定代码在隔离 world 原子校验和操作同一节点。所有实参经 CDP 结构化传递。 */
export const PROMA_SELF_CONTROL_ACTION = `function (id, tag, action) {
  if (!(this instanceof HTMLElement) || this.ownerDocument !== document || !this.isConnected ||
      this.localName !== tag || this.getAttribute('data-proma-self-control') !== id ||
      this.matches(':disabled') || this.closest('[inert], [hidden], [aria-hidden="true"], [aria-disabled="true"], [role="dialog"], [role="alertdialog"]')) return false;
  if (tag === 'button' && (!(this instanceof HTMLButtonElement) || this.type !== 'button')) return false;
  if (tag === 'input' && (!(this instanceof HTMLInputElement) || this.type !== 'text' || this.readOnly)) return false;
  if (document.querySelector('[aria-modal="true"], dialog:modal, [role="alertdialog"][data-state="open"], [role="dialog"][data-state="open"]')) return false;
  if (!this.checkVisibility({ opacityProperty: true, visibilityProperty: true, contentVisibilityAuto: true })) return false;
  const style = getComputedStyle(this);
  if (style.visibility !== 'visible' || (tag === 'div' && !['auto', 'scroll', 'overlay'].includes(style.overflowY))) return false;
  const rect = this.getBoundingClientRect();
  const x = Math.max(0, rect.left), y = Math.max(0, rect.top);
  const width = Math.min(innerWidth, rect.right) - x, height = Math.min(innerHeight, rect.bottom) - y;
  if (width <= 0 || height <= 0) return false;
  const hit = document.elementFromPoint(x + width / 2, y + height / 2);
  if (!hit || !this.contains(hit)) return false;
  if (!action) return { x, y, width, height };
  if (tag === 'button' && action.type === 'click') { this.click(); return true; }
  if (tag === 'div' && action.type === 'scroll') {
    this.scrollBy({ top: action.value, behavior: 'instant' });
    return true;
  }
  if (tag === 'input' && (action.type === 'fill' || action.type === 'press')) {
    const type = action.type === 'fill' ? ${JSON.stringify(PROMA_SELF_SEARCH_FILL_EVENT)} : ${JSON.stringify(PROMA_SELF_SEARCH_PRESS_EVENT)};
    return !this.dispatchEvent(new CustomEvent(type, { detail: action.value, cancelable: true }));
  }
  return false;
}`
