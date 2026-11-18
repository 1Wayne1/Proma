import type { BrowserWindow } from 'electron'

let mainWindow: BrowserWindow | null = null
let rendererEntryUrl: string | null = null

/** 由应用入口维护、供底层服务安全读取的主窗口引用。 */
export function setMainWindow(window: BrowserWindow, entryUrl: string): void
export function setMainWindow(window: null): void
export function setMainWindow(window: BrowserWindow | null, entryUrl?: string): void {
  mainWindow = window
  rendererEntryUrl = window && entryUrl ? new URL(entryUrl).href : null
}

export function getMainWindow(): BrowserWindow | null {
  return mainWindow && !mainWindow.isDestroyed() ? mainWindow : null
}

/** 调用者只能取得应用创建主窗口时登记的渲染入口。 */
export function getMainWindowRenderer(): { window: BrowserWindow; entryUrl: string } | null {
  const window = getMainWindow()
  return window && rendererEntryUrl ? { window, entryUrl: rendererEntryUrl } : null
}
