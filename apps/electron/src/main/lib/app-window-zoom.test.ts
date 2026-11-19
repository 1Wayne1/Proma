import { describe, expect, test } from 'bun:test'
import {
  APP_WINDOW_ZOOM_STEP,
  MAX_APP_WINDOW_ZOOM_LEVEL,
  MIN_APP_WINDOW_ZOOM_LEVEL,
  changeAppWindowZoom,
  handleAppWindowZoomInput,
  resetAppWindowZoom,
  type AppWindowZoomInput,
  type AppWindowZoomWebContents,
} from './app-window-zoom'
import {
  DEFAULT_FONT_SIZES,
  FONT_SIZE_AXES,
  clampFontSize,
  resolveFontSizes,
} from '../../types/settings'

function createFakeWebContents(initialZoom = 0, destroyed = false): {
  webContents: AppWindowZoomWebContents
  getLevel: () => number
  setDestroyed: (next: boolean) => void
} {
  let zoomLevel = initialZoom
  let isDestroyedState = destroyed
  return {
    webContents: {
      isDestroyed: () => isDestroyedState,
      getZoomLevel: () => zoomLevel,
      setZoomLevel: (level: number) => {
        zoomLevel = level
      },
    },
    getLevel: () => zoomLevel,
    setDestroyed: (next: boolean) => {
      isDestroyedState = next
    },
  }
}

function createZoomKeyInput(overrides: Partial<AppWindowZoomInput>): AppWindowZoomInput {
  return {
    type: 'keyDown',
    key: '+',
    code: 'Equal',
    meta: false,
    control: false,
    shift: true,
    alt: false,
    ...overrides,
  }
}

describe('app window zoom & 3-axis font scaling', () => {
  test('Given 主进程窗口缩放辅助 When 放大缩小与重置 Then 按 0.5 步进调整并钳位在 [-3, 9]', () => {
    const fake = createFakeWebContents(0)

    changeAppWindowZoom(fake.webContents, APP_WINDOW_ZOOM_STEP)
    expect(fake.getLevel()).toBe(0.5)

    changeAppWindowZoom(fake.webContents, 20)
    expect(fake.getLevel()).toBe(MAX_APP_WINDOW_ZOOM_LEVEL)

    changeAppWindowZoom(fake.webContents, -30)
    expect(fake.getLevel()).toBe(MIN_APP_WINDOW_ZOOM_LEVEL)

    resetAppWindowZoom(fake.webContents)
    expect(fake.getLevel()).toBe(0)
  })

  test('Given 已销毁的 webContents When 调用缩放或按键处理 Then 安全忽略且返回 false', () => {
    const fake = createFakeWebContents(1.5, true)
    changeAppWindowZoom(fake.webContents, APP_WINDOW_ZOOM_STEP)
    resetAppWindowZoom(fake.webContents)
    expect(fake.getLevel()).toBe(1.5)

    const handled = handleAppWindowZoomInput(
      createZoomKeyInput({ meta: true }),
      fake.webContents,
      'darwin',
    )
    expect(handled).toBe(false)
  })

  test('Given macOS 与 Windows/Linux 快捷键输入 When 区分是否按住 Shift Then 仅 Shift 组合触发窗口整体缩放', () => {
    const macFake = createFakeWebContents(0)

    // 不按 Shift 留给渲染进程文字缩放
    expect(handleAppWindowZoomInput(
      createZoomKeyInput({ meta: true, shift: false }),
      macFake.webContents,
      'darwin',
    )).toBe(false)
    expect(macFake.getLevel()).toBe(0)

    // macOS Cmd+Shift+=/NumpadAdd 放大，Cmd+Shift+- 缩小，Cmd+Shift+0 重置
    expect(handleAppWindowZoomInput(
      createZoomKeyInput({ meta: true, key: '=', code: 'Equal' }),
      macFake.webContents,
      'darwin',
    )).toBe(true)
    expect(macFake.getLevel()).toBe(0.5)

    expect(handleAppWindowZoomInput(
      createZoomKeyInput({ meta: true, key: '+', code: 'NumpadAdd' }),
      macFake.webContents,
      'darwin',
    )).toBe(true)
    expect(macFake.getLevel()).toBe(1)

    expect(handleAppWindowZoomInput(
      createZoomKeyInput({ meta: true, key: '_', code: 'Minus' }),
      macFake.webContents,
      'darwin',
    )).toBe(true)
    expect(macFake.getLevel()).toBe(0.5)

    expect(handleAppWindowZoomInput(
      createZoomKeyInput({ meta: true, key: ')', code: 'Digit0' }),
      macFake.webContents,
      'darwin',
    )).toBe(true)
    expect(macFake.getLevel()).toBe(0)

    // Alt 同时按下或 keyUp 事件不拦截
    expect(handleAppWindowZoomInput(
      createZoomKeyInput({ meta: true, alt: true }),
      macFake.webContents,
      'darwin',
    )).toBe(false)
    expect(handleAppWindowZoomInput(
      createZoomKeyInput({ type: 'keyUp', meta: true }),
      macFake.webContents,
      'darwin',
    )).toBe(false)

    // Windows / Linux 使用 Ctrl+Shift，Meta+Shift 不触发
    const winFake = createFakeWebContents(0)
    expect(handleAppWindowZoomInput(
      createZoomKeyInput({ meta: true, control: false }),
      winFake.webContents,
      'win32',
    )).toBe(false)
    expect(handleAppWindowZoomInput(
      createZoomKeyInput({ control: true, meta: false, key: '-', code: 'NumpadSubtract' }),
      winFake.webContents,
      'linux',
    )).toBe(true)
    expect(winFake.getLevel()).toBe(-0.5)
  })

  test('Given 三轴文字字号设置与旧版 markdownFontSize When 解析与钳位 Then 按轴边界收敛并兼容历史档位', () => {
    expect(resolveFontSizes(undefined)).toEqual(DEFAULT_FONT_SIZES)

    expect(clampFontSize('content', 4)).toBe(FONT_SIZE_AXES.content.min)
    expect(clampFontSize('content', 40)).toBe(FONT_SIZE_AXES.content.max)
    expect(clampFontSize('code', Number.NaN)).toBe(FONT_SIZE_AXES.code.default)
    expect(clampFontSize('terminal', 17.6)).toBe(18)

    expect(resolveFontSizes({ markdownFontSize: 'small' })).toEqual({
      content: 13,
      code: FONT_SIZE_AXES.code.default,
      terminal: FONT_SIZE_AXES.terminal.default,
    })
    expect(resolveFontSizes({ markdownFontSize: 'large' })).toEqual({
      content: 17,
      code: FONT_SIZE_AXES.code.default,
      terminal: FONT_SIZE_AXES.terminal.default,
    })

    // 显式三轴字号优先于旧档位，并分别按各自上限钳位
    expect(resolveFontSizes({
      markdownFontSize: 'small',
      contentFontSize: 20,
      codeFontSize: 99,
      terminalFontSize: 19,
    })).toEqual({
      content: 20,
      code: FONT_SIZE_AXES.code.max,
      terminal: 19,
    })
  })
})
