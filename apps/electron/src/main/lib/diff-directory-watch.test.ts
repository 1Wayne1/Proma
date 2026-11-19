import { describe, expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import type { FSWatcher } from 'node:fs'
import { join } from 'node:path'
import { watchDiffDirectory } from './diff-directory-watch'

interface MockWatchEntry {
  targetPath: string
  recursive: boolean
  listener: (eventType: string, filename: string | Buffer | null) => void
  watcher: FSWatcher & { closed: boolean; emit: (event: string | symbol, ...args: unknown[]) => boolean }
}

function createFakeWatchFactory(): {
  entries: MockWatchEntry[]
  watchDir: (
    targetPath: string,
    options: { recursive: boolean },
    listener: (eventType: string, filename: string | Buffer | null) => void,
  ) => FSWatcher
} {
  const entries: MockWatchEntry[] = []

  const watchDir = (
    targetPath: string,
    options: { recursive: boolean },
    listener: (eventType: string, filename: string | Buffer | null) => void,
  ): FSWatcher => {
    const emitter = new EventEmitter() as EventEmitter & {
      closed: boolean
      close: () => void
      ref: () => FSWatcher
      unref: () => FSWatcher
    }
    emitter.closed = false
    emitter.close = () => {
      emitter.closed = true
    }
    emitter.ref = () => emitter as unknown as FSWatcher
    emitter.unref = () => emitter as unknown as FSWatcher

    const watcher = emitter as unknown as FSWatcher & {
      closed: boolean
      emit: (event: string | symbol, ...args: unknown[]) => boolean
    }
    entries.push({
      targetPath,
      recursive: options.recursive,
      listener,
      watcher,
    })
    return watcher
  }

  return { entries, watchDir }
}

describe('watchDiffDirectory', () => {
  test('Given 普通仓库目录 When 创建 diff 监听 Then 仅附加主 worktree 递归监听', () => {
    const worktreePath = '/tmp/repo-main'
    const factory = createFakeWatchFactory()
    const changes: Array<string | null> = []

    const handle = watchDiffDirectory(
      worktreePath,
      true,
      (name) => {
        changes.push(name)
      },
      {
        watchDir: factory.watchDir,
        gitDirOf: () => join(worktreePath, '.git'),
        commonDirOf: () => join(worktreePath, '.git'),
        pathExists: () => true,
      },
    )

    expect(factory.entries).toHaveLength(1)
    expect(factory.entries[0]?.targetPath).toBe(worktreePath)
    expect(factory.entries[0]?.recursive).toBe(true)

    factory.entries[0]?.listener('change', 'src/index.ts')
    expect(changes).toEqual(['src/index.ts'])

    handle.close()
    expect(factory.entries[0]?.watcher.closed).toBe(true)
  })

  test('Given linked worktree 与存在的 origin/main ref When 创建监听 Then 附加外部 gitDir 与 origin/main 辅助监听并正确过滤元数据', () => {
    const worktreePath = '/tmp/wt-feature'
    const commonDir = '/tmp/repo-main/.git'
    const linkedGitDir = join(commonDir, 'worktrees', 'feature')
    const originMainRef = join(commonDir, 'refs', 'remotes', 'origin', 'main')
    const factory = createFakeWatchFactory()
    const changes: Array<string | null> = []

    const handle = watchDiffDirectory(
      worktreePath,
      true,
      (name) => {
        changes.push(name)
      },
      {
        watchDir: factory.watchDir,
        gitDirOf: () => linkedGitDir,
        commonDirOf: () => commonDir,
        pathExists: (target) => target === originMainRef,
      },
    )

    expect(factory.entries).toHaveLength(3)
    expect(factory.entries[1]).toMatchObject({ targetPath: linkedGitDir, recursive: false })
    expect(factory.entries[2]).toMatchObject({ targetPath: originMainRef, recursive: false })

    // 关键 git diff 元数据触发刷新，无关日志/FETCH_HEAD 忽略
    factory.entries[1]?.listener('change', 'HEAD')
    factory.entries[1]?.listener('change', 'index')
    factory.entries[1]?.listener('change', 'MERGE_HEAD')
    factory.entries[1]?.listener('change', 'FETCH_HEAD')
    factory.entries[1]?.listener('change', 'logs/HEAD')
    factory.entries[1]?.listener('change', null)
    factory.entries[2]?.listener('change', 'main')

    expect(changes).toEqual([null, null, null, null, null])

    // 辅助 watcher 报错时不应抛异常，close() 后不再触发回调
    expect(() => factory.entries[1]?.watcher.emit('error', new Error('ENOENT'))).not.toThrow()
    handle.close()
    handle.close()
    expect(factory.entries.every((entry) => entry.watcher.closed)).toBe(true)

    factory.entries[1]?.listener('change', 'index')
    expect(changes).toHaveLength(5)
  })

  test('Given linked worktree 缺少 origin/main 或非递归子目录监听 When 创建监听 Then 跳过不存在的 ref 且正常传递主 watcher 错误', () => {
    const worktreePath = '/tmp/wt-no-origin'
    const commonDir = '/tmp/repo/.git'
    const linkedGitDir = join(commonDir, 'worktrees', 'no-origin')
    const factory = createFakeWatchFactory()
    const errors: string[] = []

    const handle = watchDiffDirectory(
      worktreePath,
      true,
      () => {},
      {
        watchDir: factory.watchDir,
        gitDirOf: () => linkedGitDir,
        commonDirOf: () => commonDir,
        pathExists: () => false,
      },
    )

    expect(factory.entries).toHaveLength(2)
    handle.onError((err) => errors.push(err.message))
    factory.entries[0]?.watcher.emit('error', new Error('primary-boom'))
    expect(errors).toEqual(['primary-boom'])
    handle.close()

    // 非递归监听不查询 gitDir
    const shallowFactory = createFakeWatchFactory()
    let queriedGitDir = false
    const shallow = watchDiffDirectory(
      '/tmp/file-dir',
      false,
      () => {},
      {
        watchDir: shallowFactory.watchDir,
        gitDirOf: () => {
          queriedGitDir = true
          return null
        },
      },
    )
    expect(queriedGitDir).toBe(false)
    expect(shallowFactory.entries).toHaveLength(1)
    shallow.close()
  })
})
