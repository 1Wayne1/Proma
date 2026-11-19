/**
 * 应用窗口整体缩放（Cmd/Ctrl+Shift++ / - / 0）
 *
 * 与渲染进程“文字大小调整”（Cmd/Ctrl++ / - / 0）明确分离：
 * 仅响应携带 Shift 的主修饰键组合，在主进程直接调整 Chromium zoomLevel。
 */

import type { WebContents } from 'electron'

export const APP_WINDOW_ZOOM_STEP = 0.5
export const MIN_APP_WINDOW_ZOOM_LEVEL = -3
export const MAX_APP_WINDOW_ZOOM_LEVEL = 9

export interface AppWindowZoomWebContents {
  isDestroyed: () => boolean
  getZoomLevel: () => number
  setZoomLevel: (level: number) => void
}

export interface AppWindowZoomInput {
  type: string
  key: string
  code?: string
  meta: boolean
  control: boolean
  shift: boolean
  alt: boolean
}

export function changeAppWindowZoom(webContents: AppWindowZoomWebContents, delta: number): void {
  if (webContents.isDestroyed()) return
  const current = webContents.getZoomLevel()
  const next = Math.min(MAX_APP_WINDOW_ZOOM_LEVEL, Math.max(MIN_APP_WINDOW_ZOOM_LEVEL, current + delta))
  webContents.setZoomLevel(next)
}

export function resetAppWindowZoom(webContents: AppWindowZoomWebContents): void {
  if (!webContents.isDestroyed()) {
    webContents.setZoomLevel(0)
  }
}

export function handleAppWindowZoomInput(
  input: AppWindowZoomInput,
  webContents: AppWindowZoomWebContents,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (input.type !== 'keyDown' || webContents.isDestroyed()) return false
  const primaryModifier = platform === 'darwin'
    ? input.meta && !input.control
    : input.control && !input.meta
  if (!primaryModifier || !input.shift || input.alt) return false

  const key = input.key.toLowerCase()
  if (key === '+' || key === '=' || input.code === 'Equal' || input.code === 'NumpadAdd') {
    changeAppWindowZoom(webContents, APP_WINDOW_ZOOM_STEP)
    return true
  }
  if (key === '-' || key === '_' || input.code === 'Minus' || input.code === 'NumpadSubtract') {
    changeAppWindowZoom(webContents, -APP_WINDOW_ZOOM_STEP)
    return true
  }
  if (key === '0' || key === ')' || input.code === 'Digit0' || input.code === 'Numpad0') {
    resetAppWindowZoom(webContents)
    return true
  }
  return false
}

export function installAppWindowZoomShortcuts(webContents: WebContents): void {
  webContents.on('before-input-event', (event, input) => {
    if (handleAppWindowZoomInput(input, webContents)) {
      event.preventDefault()
    }
  })
}
