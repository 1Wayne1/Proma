/**
 * 主进程字号步进与跨窗口广播
 *
 * 将 Cmd/Ctrl++ / - / 0（以及视图菜单文字缩放动作）统一持久化到
 * contentFontSize / codeFontSize / terminalFontSize，并实时广播到所有窗口。
 */

import { BrowserWindow } from 'electron'
import {
  DEFAULT_FONT_SIZES,
  SETTINGS_IPC_CHANNELS,
  clampFontSize,
  resolveFontSizes,
  type AppSettings,
  type FontRole,
  type FontSizes,
  type LiveLocalPreferences,
} from '../../types'
import { getSettings, updateSettings } from './settings-service'

const FONT_ROLES: readonly FontRole[] = ['content', 'code', 'terminal']

function buildLivePreferencesPayload(settings: AppSettings): LiveLocalPreferences {
  return {
    markdownFontSize: settings.markdownFontSize,
    contentFontSize: settings.contentFontSize,
    codeFontSize: settings.codeFontSize,
    terminalFontSize: settings.terminalFontSize,
    shortcutOverrides: settings.shortcutOverrides,
  }
}

export function broadcastFontSizes(settings: AppSettings, exceptWebContentsId?: number): void {
  const payload = buildLivePreferencesPayload(settings)
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed() || win.webContents.isDestroyed()) continue
    if (exceptWebContentsId !== undefined && win.webContents.id === exceptWebContentsId) continue
    try {
      win.webContents.send(SETTINGS_IPC_CHANNELS.LIVE_LOCAL_PREFERENCES_CHANGED, payload)
    } catch (error) {
      console.warn('[设置] 同步文字大小到窗口失败:', error)
    }
  }
}

export function stepFontSizesInMain(delta: number): FontSizes {
  const current = resolveFontSizes(getSettings())
  const next: FontSizes = {
    content: clampFontSize('content', current.content + delta),
    code: clampFontSize('code', current.code + delta),
    terminal: clampFontSize('terminal', current.terminal + delta),
  }
  if (FONT_ROLES.every((role) => next[role] === current[role])) {
    return current
  }
  const updated = updateSettings({
    contentFontSize: next.content,
    codeFontSize: next.code,
    terminalFontSize: next.terminal,
  })
  broadcastFontSizes(updated)
  return next
}

export function resetFontSizesInMain(): FontSizes {
  const updated = updateSettings({
    contentFontSize: DEFAULT_FONT_SIZES.content,
    codeFontSize: DEFAULT_FONT_SIZES.code,
    terminalFontSize: DEFAULT_FONT_SIZES.terminal,
    markdownFontSize: 'medium',
  })
  broadcastFontSizes(updated)
  return { ...DEFAULT_FONT_SIZES }
}
