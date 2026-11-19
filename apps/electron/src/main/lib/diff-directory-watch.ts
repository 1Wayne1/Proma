/**
 * Worktree Diff 目录监听辅助模块
 *
 * 对普通 Git 仓库与 linked worktree 统一创建监听：
 * linked worktree 的 `.git` 是一个指向外部 `<commonDir>/worktrees/<name>` 的文本文件，
 * 单纯递归监听 worktree 目录本身收不到 HEAD、index、MERGE_HEAD 或 origin/main 更新。
 */

import { existsSync, watch } from 'node:fs'
import type { FSWatcher } from 'node:fs'
import { join, resolve } from 'node:path'
import { getGitCommonDirPath, getGitDirPath } from './git-diff-service'
import { normalizeWatchFilename, shouldNotifyForWatchFilename } from './workspace-watcher-utils'

const LINKED_GIT_DIFF_METADATA_FILE = /^(HEAD|index|ORIG_HEAD|MERGE_HEAD|CHERRY_PICK_HEAD|REVERT_HEAD)$/

export interface DiffDirectoryWatcher {
  close: () => void
  onError: (listener: (error: Error) => void) => void
}

export interface DiffDirectoryWatchDeps {
  watchDir?: (
    targetPath: string,
    options: { recursive: boolean },
    listener: (eventType: string, filename: string | Buffer | null) => void,
  ) => FSWatcher
  gitDirOf?: (gitRoot: string) => string | null
  commonDirOf?: (gitDir: string) => string
  pathExists?: (targetPath: string) => boolean
}

export function watchDiffDirectory(
  dirPath: string,
  recursive: boolean,
  onChange: (normalizedFilename: string | null) => void,
  deps?: DiffDirectoryWatchDeps,
): DiffDirectoryWatcher {
  const watchFs = deps?.watchDir ?? ((targetPath, options, listener) => watch(targetPath, options, listener))
  const gitDirOf = deps?.gitDirOf ?? getGitDirPath
  const commonDirOf = deps?.commonDirOf ?? getGitCommonDirPath
  const pathExists = deps?.pathExists ?? existsSync

  let closed = false
  const worktreeWatcher = watchFs(dirPath, { recursive }, (_eventType, filename) => {
    if (closed) return
    const normalized = normalizeWatchFilename(filename)
    if (normalized === null || !shouldNotifyForWatchFilename(normalized)) return
    onChange(normalized)
  })

  const extraWatchers: FSWatcher[] = []
  const attachAuxiliaryWatcher = (targetPath: string, listener: (filename: string | Buffer | null) => void): void => {
    try {
      const auxWatcher = watchFs(targetPath, { recursive: false }, (_eventType, filename) => {
        if (closed) return
        listener(filename)
      })
      auxWatcher.on('error', () => {
        // 辅助元数据目录在删除/重建仓库期间可能短暂失效，不中断主 worktree watcher。
      })
      extraWatchers.push(auxWatcher)
    } catch {
      // 目标元数据文件不存在或暂不可监听时忽略。
    }
  }

  const gitDir = recursive ? gitDirOf(dirPath) : null
  const linkedGitDir = gitDir && resolve(gitDir) !== resolve(dirPath, '.git') ? gitDir : null
  if (linkedGitDir) {
    attachAuxiliaryWatcher(linkedGitDir, (filename) => {
      const normalized = normalizeWatchFilename(filename)
      if (normalized === null || LINKED_GIT_DIFF_METADATA_FILE.test(normalized)) {
        onChange(null)
      }
    })
    const originMainRefPath = join(commonDirOf(linkedGitDir), 'refs', 'remotes', 'origin', 'main')
    if (pathExists(originMainRefPath)) {
      attachAuxiliaryWatcher(originMainRefPath, () => {
        onChange(null)
      })
    }
  }

  return {
    close: () => {
      if (closed) return
      closed = true
      try { worktreeWatcher.close() } catch { /* watcher may already be closed */ }
      for (const aux of extraWatchers) {
        try { aux.close() } catch { /* watcher may already be closed */ }
      }
    },
    onError: (listener) => {
      worktreeWatcher.on('error', listener)
    },
  }
}
