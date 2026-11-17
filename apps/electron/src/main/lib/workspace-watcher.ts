import { DirectoryWatchSubscriptions } from './directory-watch-subscriptions'
import { subscribeWorkspaceResourcesChanged } from './workspace-resource-events'
import { getProjectFilesPath, getWorkspaceAttachedDirectories, getWorkspaceAttachedFiles, listAgentWorkspaces } from './agent-workspace-manager'
import { isWithinTurnRoot } from './turn-changes/paths'
/**
 * 工作区文件监听器
 *
 * 使用 fs.watch 递归监听 ~/.proma/agent-workspaces/ 目录，
 * 根据变化的文件路径区分事件类型：
 * - mcp.json / skills/ / skills-inactive/ 变化 → 推送 CAPABILITIES_CHANGED（侧边栏刷新）
 * - 其他文件变化 → 推送 WORKSPACE_FILES_CHANGED（文件浏览器刷新）
 *
 * 同时支持监听附加目录（外部路径），变化时统一推送 WORKSPACE_FILES_CHANGED。
 *
 * 所有事件均做 debounce 防抖，避免高频文件操作导致渲染进程风暴。
 */

import { watch, existsSync, statSync } from 'node:fs'
import type { FSWatcher } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import type { BrowserWindow } from 'electron'
import { AGENT_IPC_CHANNELS } from '@proma/shared'
import { getAgentWorkspacesDir } from './config-paths'
import { listAgentSessions } from './agent-session-manager'
import { invalidateGitDiffCache } from './git-diff-service'
import { classifyWorkspaceWatchFilename, isHighNoisePath, normalizeWatchFilename, shouldNotifyForWatchFilename } from './workspace-watcher-utils'

/** debounce 延迟（ms） */
const DEBOUNCE_MS = 300

/** watcher 'error' 事件后的自愈重启延迟（ms），避免对持续故障状态紧密重试 */
const WATCHER_RESTART_DELAY_MS = 5000

/** 主监听或父目录监听的延迟重启定时器，停止时统一清理。 */
const watcherRestartTimers = new Set<ReturnType<typeof setTimeout>>()
let workspaceWatcherActive = false

function scheduleWatcherRestart(callback: () => void): void {
  const timer = setTimeout(() => {
    watcherRestartTimers.delete(timer)
    if (workspaceWatcherActive) callback()
  }, WATCHER_RESTART_DELAY_MS)
  watcherRestartTimers.add(timer)
}

// 高频变动目录：跳过其中的变更事件，防止 node_modules / .next 等产生 IPC 事件风暴

let watcher: FSWatcher | null = null

/** 已存在的附加目录监听器：路径 → FSWatcher */
const attachedWatchers = new Map<string, FSWatcher>()
const directorySubscriptions = new DirectoryWatchSubscriptions(path => {
  // 主监听已经递归覆盖受管目录，不另开重复的底层 watcher。
  if (!isWithinTurnRoot(resolve(getAgentWorkspacesDir()), path)) startAttachedDirectory(path)
}, stopAttachedDirectory)
let resourceRelease: (() => void) | undefined
let resourceSyncPending = false
let capabilitiesTimer: ReturnType<typeof setTimeout> | null = null
let filesTimer: ReturnType<typeof setTimeout> | null = null
const changedFilePaths = new Set<string>()

/** 从持久化的显式会话/工作区归属重建引用；删除、迁移和自动化路径同样生效。 */
export function syncWorkspaceDirectoryWatchers(): void {
  if (!workspaceWatcherActive) return
  const desired = new Map<string, string[]>()
  for (const workspace of listAgentWorkspaces()) desired.set(`workspace:${workspace.id}`, [
    getProjectFilesPath(workspace.slug), ...getWorkspaceAttachedDirectories(workspace.slug),
    ...getWorkspaceAttachedFiles(workspace.slug).map(path => dirname(path)),
  ])
  for (const session of listAgentSessions()) desired.set(`session:${session.id}`, [
    ...session.attachedDirectories ?? [], ...session.attachedFiles?.map(path => dirname(path)) ?? [],
    ...session.activeWorktree?.path ? [session.activeWorktree.path] : [],
  ])
  directorySubscriptions.sync(desired)
}


/** 最近存在的父目录监听器，多个缺失根可复用同一个监听器。 */
interface ParentDirectoryWatcher {
  watcher: FSWatcher
  targetPaths: Set<string>
}
const parentDirectoryWatchers = new Map<string, ParentDirectoryWatcher>()
/** 缺失/失效的目标目录 → 正在监听的最近存在父目录。 */
const unavailableDirectoryParents = new Map<string, string>()

/** 附加目录防抖定时器 */
let attachedFilesTimer: ReturnType<typeof setTimeout> | null = null
/** 附加目录最近一次变化路径，随 debounce 事件一起发送。 */
const attachedChangedPaths = new Set<string>()
/** 主窗口引用（供附加目录监听器使用） */
let mainWin: BrowserWindow | null = null

function notifyWorkspaceFilesChanged(changedPath?: string): void {
  if (!mainWin || mainWin.isDestroyed()) return

  if (attachedFilesTimer) clearTimeout(attachedFilesTimer)
  if (changedPath) attachedChangedPaths.add(changedPath)
  attachedFilesTimer = setTimeout(() => {
    const changedPaths = [...attachedChangedPaths]
    attachedChangedPaths.clear()
    attachedFilesTimer = null
    if (mainWin && !mainWin.isDestroyed()) {
      // 保留删除路径，使当前预览也能从旧缓存切换到“文件不存在”状态。
      mainWin.webContents.send(AGENT_IPC_CHANNELS.WORKSPACE_FILES_CHANGED, changedPaths)
    }
  }, DEBOUNCE_MS)
}

function isExistingDirectory(dirPath: string): boolean {
  if (!existsSync(dirPath)) return false
  try {
    return statSync(dirPath).isDirectory()
  } catch {
    return false
  }
}

function findNearestExistingDirectory(dirPath: string): string | null {
  let candidate = dirPath
  while (true) {
    if (isExistingDirectory(candidate)) return candidate
    const parent = dirname(candidate)
    if (parent === candidate) return null
    candidate = parent
  }
}

function releaseUnavailableDirectoryWatcher(dirPath: string): void {
  const parentPath = unavailableDirectoryParents.get(dirPath)
  if (!parentPath) return

  unavailableDirectoryParents.delete(dirPath)
  const entry = parentDirectoryWatchers.get(parentPath)
  if (!entry) return

  entry.targetPaths.delete(dirPath)
  if (entry.targetPaths.size > 0) return

  try { entry.watcher.close() } catch { /* watcher may already be closed */ }
  parentDirectoryWatchers.delete(parentPath)
  console.log('[附加目录监听] 已停止父目录监听:', parentPath)
}

function watchUnavailableDirectoryParent(dirPath: string): void {
  const parentPath = findNearestExistingDirectory(dirname(dirPath))
  if (!parentPath) {
    console.warn('[附加目录监听] 找不到可监听的父目录:', dirPath)
    return
  }

  const currentParentPath = unavailableDirectoryParents.get(dirPath)
  if (currentParentPath === parentPath) return
  if (currentParentPath) releaseUnavailableDirectoryWatcher(dirPath)

  let entry = parentDirectoryWatchers.get(parentPath)
  if (!entry) {
    try {
      const targetPaths = new Set<string>()
      const watcher = watch(parentPath, { recursive: false }, (_eventType, filename) => {
        if (!workspaceWatcherActive || parentDirectoryWatchers.get(parentPath)?.watcher !== watcher) return
        for (const path of [...targetPaths]) if (directorySubscriptions.has(path) && isExistingDirectory(path)) startAttachedDirectory(path)
        // 目录恢复、替换或权限变化后，通知 renderer 重新读取即时 root status。
        const normalizedFilename = normalizeWatchFilename(filename)
        if (normalizedFilename === null) {
          // filename 不可用时，仅在目标目录已经恢复时通知，避免未知噪声绕过过滤。
          if ([...targetPaths].some((targetPath) => isExistingDirectory(targetPath))) {
            notifyWorkspaceFilesChanged()
          }
          return
        }

        const changedPath = resolve(parentPath, normalizedFilename)
        const isTargetRecovery = [...targetPaths].some(
          (targetPath) => resolve(targetPath) === changedPath,
        )
        if (!isTargetRecovery && isHighNoisePath(normalizedFilename)) return
        notifyWorkspaceFilesChanged()
      })
      entry = { watcher, targetPaths }
      parentDirectoryWatchers.set(parentPath, entry)

      watcher.on('error', (err) => {
        if (parentDirectoryWatchers.get(parentPath)?.watcher !== watcher) return
        console.error('[附加目录监听] 父目录监听出错，等待下次访问重建:', parentPath, err)
        try { watcher.close() } catch { /* watcher may already be closed */ }
        parentDirectoryWatchers.delete(parentPath)
        const pathsToRestore = [...entry!.targetPaths]
        for (const targetPath of pathsToRestore) {
          unavailableDirectoryParents.delete(targetPath)
        }
        scheduleWatcherRestart(() => {
          for (const targetPath of pathsToRestore) {
            if (directorySubscriptions.has(targetPath) && !attachedWatchers.has(targetPath) && !unavailableDirectoryParents.has(targetPath)) {
              startAttachedDirectory(targetPath)
            }
          }
        })
      })
      console.log('[附加目录监听] 已启动父目录监听:', parentPath)
    } catch (error) {
      console.error('[附加目录监听] 启动父目录监听失败:', parentPath, error)
      return
    }
  }

  entry.targetPaths.add(dirPath)
  unavailableDirectoryParents.set(dirPath, parentPath)
}

/**
 * 启动工作区文件监听
 *
 * @param win 主窗口引用，用于向渲染进程推送事件
 */
export function startWorkspaceWatcher(win: BrowserWindow): void {
  workspaceWatcherActive = true
  mainWin = win
  // 会话附加目录只需在启动/监听器重启时恢复一次；LIST_SESSIONS 是高频读取路径，
  // 不能随每次列表 IPC 再遍历全部会话并触发同步 stat。
  resourceRelease ??= subscribeWorkspaceResourcesChanged(() => {
    if (resourceSyncPending || !workspaceWatcherActive) return
    resourceSyncPending = true
    queueMicrotask(() => {
      resourceSyncPending = false
      if (workspaceWatcherActive) { try { syncWorkspaceDirectoryWatchers() } catch (error) { console.warn('[目录监听] 同步资源失败:', error) } }
    })
  })
  syncWorkspaceDirectoryWatchers()
  const watchDir = getAgentWorkspacesDir()

  if (!existsSync(watchDir)) {
    console.warn('[工作区监听] 目录不存在，跳过:', watchDir)
    return
  }

  if (watcher) return

  try {
    watcher = watch(watchDir, { recursive: true }, (_eventType, filename) => {
      if (!filename || win.isDestroyed()) return

      // filename 格式: {slug}/mcp.json 或 {slug}/skills/xxx/SKILL.md 或 {slug}/{sessionId}/file.txt
      const normalizedFilename = normalizeWatchFilename(filename)
      if (normalizedFilename === null) return

      // 普通文件及有限的 Diff 状态元数据变更均需失效缓存；fetch 的高噪声 Git 元数据仍被忽略。
      if (shouldNotifyForWatchFilename(normalizedFilename)) {
        invalidateGitDiffCache(join(watchDir, normalizedFilename))
      }
      const changeType = classifyWorkspaceWatchFilename(normalizedFilename)
      if (!changeType) return

      if (changeType === 'capabilities') {
        // MCP/Skills 变化 → 通知侧边栏刷新
        if (capabilitiesTimer) clearTimeout(capabilitiesTimer)
        capabilitiesTimer = setTimeout(() => {
          if (!win.isDestroyed()) {
            win.webContents.send(AGENT_IPC_CHANNELS.CAPABILITIES_CHANGED)
          }
          capabilitiesTimer = null
        }, DEBOUNCE_MS)
      } else {
        // 其他文件变化 → 通知文件浏览器刷新。保留删除与目录路径，
        // renderer 会在记录会话文件改动前确认路径仍是实际文件。
        if (filesTimer) clearTimeout(filesTimer)
        changedFilePaths.add(join(watchDir, normalizedFilename))
        filesTimer = setTimeout(() => {
          const paths = [...changedFilePaths]
          changedFilePaths.clear()
          filesTimer = null
          if (!win.isDestroyed()) {
            // 保留删除路径，供当前预览精确失效；文件列表自行重新读取目录。
            win.webContents.send(AGENT_IPC_CHANNELS.WORKSPACE_FILES_CHANGED, paths)
          }
        }, DEBOUNCE_MS)
      }
    })

    // EventEmitter 在 'error' 事件无监听器时会抛出未捕获异常并终止 Electron 主进程，
    // 当目录被删除/权限变更/iCloud 同步异常等运行时错误发生时即触发。必须显式监听并降级。
    const runningWatcher = watcher
    watcher.on('error', (err) => {
      if (watcher !== runningWatcher || !workspaceWatcherActive) return
      console.error('[工作区监听] 运行时错误，将尝试自愈重启:', err)
      try { watcher?.close() } catch { /* watcher 可能已自动关闭 */ }
      watcher = null
      scheduleWatcherRestart(() => {
        if (!win.isDestroyed() && !watcher) startWorkspaceWatcher(win)
      })
    })

    console.log('[工作区监听] 已启动文件监听:', watchDir)
  } catch (error) {
    console.error('[工作区监听] 启动失败:', error)
  }
}

/**
 * 停止工作区文件监听
 */
export function stopWorkspaceWatcher(): void {
  workspaceWatcherActive = false
  resourceRelease?.()
  resourceRelease = undefined
  directorySubscriptions.clear()
  if (capabilitiesTimer) clearTimeout(capabilitiesTimer)
  if (filesTimer) clearTimeout(filesTimer)
  capabilitiesTimer = filesTimer = null
  changedFilePaths.clear()
  for (const timer of watcherRestartTimers) clearTimeout(timer)
  watcherRestartTimers.clear()
  if (watcher) {
    watcher.close()
    watcher = null
    console.log('[工作区监听] 已停止')
  }
  // 同时清理所有附加目录及其缺失路径父目录监听器。
  for (const [dirPath, w] of attachedWatchers) {
    w.close()
    console.log('[附加目录监听] 已停止:', dirPath)
  }
  attachedWatchers.clear()
  for (const [parentPath, entry] of parentDirectoryWatchers) {
    try { entry.watcher.close() } catch { /* watcher may already be closed */ }
    console.log('[附加目录监听] 已停止父目录监听:', parentPath)
  }
  parentDirectoryWatchers.clear()
  unavailableDirectoryParents.clear()
  if (attachedFilesTimer) clearTimeout(attachedFilesTimer)
  attachedFilesTimer = null
  attachedChangedPaths.clear()
  mainWin = null
}

/**
 * 开始监听附加目录
 * 当目录内文件变化时，推送 WORKSPACE_FILES_CHANGED 事件
 */
export function watchAttachedDirectory(_dirPath: string): void { syncWorkspaceDirectoryWatchers() }

function startAttachedDirectory(dirPath: string): void {
  if (!workspaceWatcherActive || !directorySubscriptions.has(dirPath)) return
  if (!isExistingDirectory(dirPath)) {
    // 本地项目根一开始不存在时不能直接 fs.watch；监听最近存在父目录即可在其恢复时
    // 触发一次 renderer 状态刷新。多个同父路径的根共享一个 watcher。
    watchUnavailableDirectoryParent(dirPath)
    return
  }

  releaseUnavailableDirectoryWatcher(dirPath)
  if (attachedWatchers.has(dirPath)) return

  try {
    const w = watch(dirPath, { recursive: true }, (_eventType, filename) => {
      if (!workspaceWatcherActive || attachedWatchers.get(dirPath) !== w || !directorySubscriptions.has(dirPath)) return
      const normalizedFilename = normalizeWatchFilename(filename)
      if (normalizedFilename === null || !shouldNotifyForWatchFilename(normalizedFilename)) return
      const changedPath = join(dirPath, normalizedFilename)
      invalidateGitDiffCache(changedPath)
      notifyWorkspaceFilesChanged(changedPath)
    })

    // 同主 watcher：监听 'error' 防止运行时异常拖死主进程。
    // 附加目录通常是用户外接的项目目录，断电/挂载/权限变化更易触发。
    w.on('error', (err) => {
      if (attachedWatchers.get(dirPath) !== w) return
      console.error('[附加目录监听] 运行时错误，切换为父目录监听:', dirPath, err)
      try { w.close() } catch { /* 已关闭 */ }
      if (attachedWatchers.get(dirPath) === w) attachedWatchers.delete(dirPath)
      if (workspaceWatcherActive && directorySubscriptions.has(dirPath)) watchUnavailableDirectoryParent(dirPath)
    })

    attachedWatchers.set(dirPath, w)
    console.log('[附加目录监听] 已启动:', dirPath)
  } catch (error) {
    console.error('[附加目录监听] 启动失败，切换为父目录监听:', dirPath, error)
    watchUnavailableDirectoryParent(dirPath)
  }
}

/**
 * 停止监听附加目录
 */
export function unwatchAttachedDirectory(_dirPath: string): void { syncWorkspaceDirectoryWatchers() }

function stopAttachedDirectory(dirPath: string): void {
  const w = attachedWatchers.get(dirPath)
  if (w) {
    try { w.close() } catch { /* watcher may already be closed */ }
    attachedWatchers.delete(dirPath)
    console.log('[附加目录监听] 已停止:', dirPath)
  }
  releaseUnavailableDirectoryWatcher(dirPath)
}
