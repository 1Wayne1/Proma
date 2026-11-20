import { describe, expect, test } from 'bun:test'
import { DEFAULT_SHORTCUTS } from './shortcut-defaults'
import { checkConflict, initShortcutRegistry, isMac, registerShortcut } from './shortcut-registry'

describe('文字缩放与窗口缩放默认快捷键', () => {
  test('Given 默认快捷键清单 When 查找字号与界面缩放条目 Then Cmd/Ctrl+±/0 控制文字大小且带 Shift 控制界面整体缩放', () => {
    expect(DEFAULT_SHORTCUTS.find((shortcut) => shortcut.id === 'font-size-increase')).toMatchObject({
      defaultMac: 'Cmd+Plus',
      defaultWin: 'Ctrl+Plus',
      category: 'app',
    })
    expect(DEFAULT_SHORTCUTS.find((shortcut) => shortcut.id === 'font-size-increase')?.readonly).toBeUndefined()
    expect(DEFAULT_SHORTCUTS.find((shortcut) => shortcut.id === 'font-size-decrease')).toMatchObject({
      defaultMac: 'Cmd+Minus',
      defaultWin: 'Ctrl+Minus',
      category: 'app',
    })
    expect(DEFAULT_SHORTCUTS.find((shortcut) => shortcut.id === 'font-size-reset')).toMatchObject({
      defaultMac: 'Cmd+0',
      defaultWin: 'Ctrl+0',
      category: 'app',
    })

    expect(DEFAULT_SHORTCUTS.find((shortcut) => shortcut.id === 'zoom-in')).toMatchObject({
      defaultMac: 'Cmd+Shift+Plus',
      defaultWin: 'Ctrl+Shift+Plus',
      readonly: true,
    })
    expect(DEFAULT_SHORTCUTS.find((shortcut) => shortcut.id === 'zoom-out')).toMatchObject({
      defaultMac: 'Cmd+Shift+Minus',
      defaultWin: 'Ctrl+Shift+Minus',
      readonly: true,
    })
    expect(DEFAULT_SHORTCUTS.find((shortcut) => shortcut.id === 'reset-zoom')).toMatchObject({
      defaultMac: 'Cmd+Shift+0',
      defaultWin: 'Ctrl+Shift+0',
      readonly: true,
    })
  })

  test('Given 默认缩小文字快捷键 When 按减号或数字键盘减号 Then 缩小文字且带 Shift 的组合不触发', () => {
    const target = new EventTarget()
    const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
    Object.defineProperty(globalThis, 'window', { configurable: true, value: target })
    let executed = 0
    const unregister = registerShortcut('font-size-decrease', () => { executed++ })
    try {
      initShortcutRegistry()
      const press = (key: string, code: string, shiftKey = false) => {
        const event = Object.assign(new Event('keydown', { cancelable: true }), {
          key, code, shiftKey, metaKey: isMac, ctrlKey: !isMac, altKey: false,
        })
        target.dispatchEvent(event)
        return event.defaultPrevented
      }

      expect(press('-', 'Minus')).toBe(true)
      expect(press('Unidentified', 'NumpadSubtract')).toBe(true)
      expect(press('_', 'Minus', true)).toBe(false)
      expect(executed).toBe(2)
      expect(checkConflict(isMac ? 'Cmd+-' : 'Ctrl+-')).toBe('font-size-decrease')
    } finally {
      unregister()
      if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
      else Reflect.deleteProperty(globalThis, 'window')
    }
  })
})
