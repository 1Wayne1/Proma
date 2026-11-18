export const PROMA_SELF_FILE_SEARCH = 'file-search'
export const PROMA_SELF_SCREENSHOT_TOOL = 'PromaSelfScreenshot'
export const PROMA_SELF_SEARCH_FILL_EVENT = 'proma-self:search-fill'
export const PROMA_SELF_SEARCH_PRESS_EVENT = 'proma-self:search-press'
export const PROMA_SELF_SEARCH_KEYS = ['ArrowUp', 'ArrowDown', 'Escape'] as const
export type PromaSelfSearchKey = typeof PROMA_SELF_SEARCH_KEYS[number]

export function isPromaSelfSearchKey(value: unknown): value is PromaSelfSearchKey {
  return PROMA_SELF_SEARCH_KEYS.some(key => key === value)
}

export function isPromaSelfSearchText(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 256 && !/[\x00-\x1f\x7f]/.test(value)
}
