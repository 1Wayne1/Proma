import { Menu, shell, BrowserWindow } from 'electron'
import { APP_WINDOW_ZOOM_STEP, changeAppWindowZoom, resetAppWindowZoom } from './lib/app-window-zoom'
import { resetFontSizesInMain, stepFontSizesInMain } from './lib/font-sizes'

export function createApplicationMenu(): Menu {
  const isMac = process.platform === 'darwin'

  /**
   * 菜单快捷键说明：
   *
   * 大部分快捷键由渲染进程的 shortcut-registry 统一管理。
   * 但 Cmd+W 需要在菜单中拦截（否则 macOS 默认关闭窗口），
   * 改为通知渲染进程关闭当前标签页。
   */

  /**
   * 重新加载当前窗口。
   *
   * 不使用 Electron 的 `reload` / `forceReload` role：这些 role 会自动注册
   * CmdOrCtrl+R、F5 等系统快捷键。刷新只能从原生“视图”菜单显式触发。
   */
  const reloadFocusedWindow = (ignoreCache = false): void => {
    const win = BrowserWindow.getFocusedWindow()
    if (!win || win.isDestroyed()) return

    if (ignoreCache) {
      win.webContents.reloadIgnoringCache()
    } else {
      win.webContents.reload()
    }
  }

  const zoomFocusedWindow = (delta: number): void => {
    const win = BrowserWindow.getFocusedWindow()
    if (!win || win.isDestroyed()) return
    changeAppWindowZoom(win.webContents, delta)
  }

  const resetZoomFocusedWindow = (): void => {
    const win = BrowserWindow.getFocusedWindow()
    if (!win || win.isDestroyed()) return
    resetAppWindowZoom(win.webContents)
  }

  const template: Electron.MenuItemConstructorOptions[] = [
    // 应用菜单 (仅 macOS)
    ...(isMac
      ? [
          {
            label: 'Proma',
            submenu: [
              { role: 'about' as const, label: '关于 Proma' },
              { type: 'separator' as const },
              { role: 'services' as const, label: '服务' },
              { type: 'separator' as const },
              { role: 'hide' as const, label: '隐藏 Proma' },
              { role: 'hideOthers' as const, label: '隐藏其他' },
              { role: 'unhide' as const, label: '显示全部' },
              { type: 'separator' as const },
              { role: 'quit' as const, label: '退出 Proma' },
            ],
          },
        ]
      : []),

    // 文件菜单
    {
      label: '文件',
      submenu: [
        // Cmd+W / Ctrl+W：主窗口关闭当前标签页；独立记忆窗口关闭自身。
        {
          label: '关闭标签页',
          accelerator: 'CmdOrCtrl+W',
          click: () => {
            const win = BrowserWindow.getFocusedWindow()
            if (!win) return

            let windowType: string | null = null
            try {
              windowType = new URL(win.webContents.getURL()).searchParams.get('window')
            } catch {
              // 窗口尚未加载页面时沿用主窗口的安全默认行为。
            }
            if (windowType === 'workspace-memory') {
              win.close()
              return
            }

            win.webContents.send('menu:close-tab')
          },
        },
        ...(isMac ? [] : [{ type: 'separator' as const }, { role: 'quit' as const, label: '退出' }]),
      ],
    },

    // 编辑菜单
    {
      label: '编辑',
      submenu: [
        { role: 'undo' as const, label: '撤销' },
        { role: 'redo' as const, label: '重做' },
        { type: 'separator' as const },
        { role: 'cut' as const, label: '剪切' },
        { role: 'copy' as const, label: '复制' },
        { role: 'paste' as const, label: '粘贴' },
        ...(isMac
          ? [
              { role: 'pasteAndMatchStyle' as const, label: '粘贴并匹配样式' },
              { role: 'delete' as const, label: '删除' },
              { role: 'selectAll' as const, label: '全选' },
            ]
          : [{ role: 'delete' as const, label: '删除' }, { type: 'separator' as const }, { role: 'selectAll' as const, label: '全选' }]),
      ],
    },

    // 视图菜单
    {
      label: '视图',
      submenu: [
        {
          label: '重新加载',
          click: () => reloadFocusedWindow(),
        },
        {
          label: '强制重新加载',
          click: () => reloadFocusedWindow(true),
        },
        { role: 'toggleDevTools' as const, label: '切换开发者工具' },
        { type: 'separator' as const },
        // 文字大小：实际键位在渲染进程注册（可自定义），菜单只提供入口与提示。
        {
          label: isMac ? '放大文字  ⌘+' : '放大文字  Ctrl++',
          click: () => {
            stepFontSizesInMain(1)
          },
        },
        {
          label: isMac ? '缩小文字  ⌘-' : '缩小文字  Ctrl+-',
          click: () => {
            stepFontSizesInMain(-1)
          },
        },
        {
          label: isMac ? '重置文字大小  ⌘0' : '重置文字大小  Ctrl+0',
          click: () => {
            resetFontSizesInMain()
          },
        },
        { type: 'separator' as const },
        // 界面缩放使用 Shift 组合；普通 Cmd/Ctrl 组合继续只调整文字。
        {
          label: '放大界面',
          accelerator: 'CmdOrCtrl+Shift+Plus',
          click: () => {
            zoomFocusedWindow(APP_WINDOW_ZOOM_STEP)
          },
        },
        {
          label: '缩小界面',
          accelerator: 'CmdOrCtrl+Shift+Minus',
          click: () => {
            zoomFocusedWindow(-APP_WINDOW_ZOOM_STEP)
          },
        },
        {
          label: '重置界面缩放',
          accelerator: 'CmdOrCtrl+Shift+0',
          click: () => {
            resetZoomFocusedWindow()
          },
        },
        { type: 'separator' as const },
        { role: 'togglefullscreen' as const, label: '切换全屏' },
      ],
    },

    // 窗口菜单
    {
      label: '窗口',
      submenu: [
        { role: 'minimize' as const, label: '最小化' },
        { role: 'zoom' as const, label: '缩放' },
        ...(isMac
          ? [
              { type: 'separator' as const },
              { role: 'front' as const, label: '前置全部窗口' },
              { type: 'separator' as const },
              { role: 'window' as const, label: '窗口' },
            ]
          : [{ role: 'close' as const, label: '关闭' }]),
      ],
    },

    // 帮助菜单
    {
      label: '帮助',
      role: 'help' as const,
      submenu: [
        {
          label: '了解更多',
          click: async () => {
            await shell.openExternal('https://github.com/yourusername/proma')
          },
        },
      ],
    },
  ]

  return Menu.buildFromTemplate(template)
}
