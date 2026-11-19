/**
 * 文字字号状态原子（正文 / 代码块 / 终端三轴 + 兼容 Markdown 档位）
 *
 * 1) `fontSizesAtom` 保存三类字号（px）：content (10-22)、code (10-16)、terminal (10-20)；
 * 2) 通过 CSS 变量 `--md-preview-font-size`、`--content-font-size`、`--code-font-size`、
 *    `--terminal-font-size` 与 `--reading-font-size-offset` 驱动渲染层；
 * 3) Cmd/Ctrl++ / - / 0 步进或重置全部三类字号，外置终端通过 `fontSizesAtom` 响应式调整字号；
 * 4) 持久化到 `~/.proma/settings.json`。
 */

import { atom } from 'jotai'
import {
  DEFAULT_FONT_SIZES,
  DEFAULT_MARKDOWN_FONT_SIZE,
  FONT_SIZE_AXES,
  clampFontSize,
  resolveFontSizes,
  type FontRole,
  type FontSizes,
  type MarkdownFontSize,
} from '../../types'

/** 各档位对应的正文字号（px） */
export const FONT_SIZE_PX: Record<MarkdownFontSize, number> = {
  small: 13,
  medium: 15,
  large: 17,
}

const FONT_ROLES: readonly FontRole[] = ['content', 'code', 'terminal']

/** Markdown 字号档位（兼容外观设置分段控件） */
export const markdownFontSizeAtom = atom<MarkdownFontSize>(DEFAULT_MARKDOWN_FONT_SIZE)

/** 三类文字字号（px） */
export const fontSizesAtom = atom<FontSizes>(DEFAULT_FONT_SIZES)

/**
 * 将字号档位写入 :root CSS 变量（仅更新正文兼容变量）
 */
export function applyMarkdownFontSizeToDOM(size: MarkdownFontSize): void {
  const px = FONT_SIZE_PX[size]
  const root = document.documentElement.style
  root.setProperty('--md-preview-font-size', `${px}px`)
  root.setProperty('--content-font-size', `${px}px`)
  root.setProperty('--reading-font-size-offset', `${px - FONT_SIZE_AXES.content.default}px`)
}

/**
 * 将三类字号写入 :root CSS 变量
 */
export function applyFontSizesToDOM(sizes: FontSizes): void {
  const normalized = resolveFontSizes({
    contentFontSize: sizes.content,
    codeFontSize: sizes.code,
    terminalFontSize: sizes.terminal,
  })
  const root = document.documentElement.style
  root.setProperty('--md-preview-font-size', `${normalized.content}px`)
  root.setProperty('--content-font-size', `${normalized.content}px`)
  root.setProperty('--code-font-size', `${normalized.code}px`)
  root.setProperty('--terminal-font-size', `${normalized.terminal}px`)
  root.setProperty('--reading-font-size-offset', `${normalized.content - FONT_SIZE_AXES.content.default}px`)
}

/**
 * 步进调整三类字号并持久化
 */
export async function stepFontSizes(current: FontSizes, delta: number): Promise<FontSizes> {
  const next: FontSizes = {
    content: clampFontSize('content', current.content + delta),
    code: clampFontSize('code', current.code + delta),
    terminal: clampFontSize('terminal', current.terminal + delta),
  }
  if (FONT_ROLES.every((role) => next[role] === current[role])) {
    return current
  }
  applyFontSizesToDOM(next)
  try {
    await window.electronAPI.updateSettings({
      contentFontSize: next.content,
      codeFontSize: next.code,
      terminalFontSize: next.terminal,
    })
  } catch (error) {
    console.error('[字号] 持久化失败:', error)
  }
  return next
}

/**
 * 重置三类字号为默认值并持久化
 */
export async function resetFontSizes(): Promise<FontSizes> {
  const defaults = { ...DEFAULT_FONT_SIZES }
  applyFontSizesToDOM(defaults)
  try {
    await window.electronAPI.updateSettings({
      contentFontSize: defaults.content,
      codeFontSize: defaults.code,
      terminalFontSize: defaults.terminal,
      markdownFontSize: DEFAULT_MARKDOWN_FONT_SIZE,
    })
  } catch (error) {
    console.error('[字号] 重置持久化失败:', error)
  }
  return defaults
}

/**
 * 更新 Markdown 字号档位并同步 contentFontSize 持久化
 */
export async function updateMarkdownFontSize(size: MarkdownFontSize): Promise<void> {
  applyMarkdownFontSizeToDOM(size)
  try {
    await window.electronAPI.updateSettings({
      markdownFontSize: size,
      contentFontSize: FONT_SIZE_PX[size],
    })
  } catch (error) {
    console.error('[Markdown字号] 持久化失败:', error)
  }
}
