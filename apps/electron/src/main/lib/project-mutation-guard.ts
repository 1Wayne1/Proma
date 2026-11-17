import { realpathSync } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'
import { isWithinTurnRoot, turnPathKey } from './turn-changes/paths'

const mutations = new Set<string>()
const activities = new Set<{ roots: string[]; references: number }>()

/** 不存在的子路径也沿最近祖先规范化，避免目录别名绕过正在进行的操作。 */
export function canonicalProjectPath(path: string): string {
  const absolute = resolve(path)
  try { return realpathSync(absolute) } catch {
    const parent = dirname(absolute)
    return parent === absolute ? absolute : resolve(canonicalProjectPath(parent), basename(absolute))
  }
}

export function projectPathsOverlap(first: string, second: string): boolean {
  const a = turnPathKey(canonicalProjectPath(first))
  const b = turnPathKey(canonicalProjectPath(second))
  return isWithinTurnRoot(a, b) || isWithinTurnRoot(b, a)
}

export function assertNoProjectMutation(paths: readonly string[]): void {
  if (paths.some(path => [...mutations].some(root => projectPathsOverlap(root, path)))) {
    throw new Error('项目正在恢复文件或移除 worktree，请稍后重试')
  }
}

export async function withProjectMutation<T>(root: string, operation: () => Promise<T>): Promise<T> {
  const canonical = canonicalProjectPath(root)
  assertNoProjectMutation([canonical])
  if (hasProjectActivity(canonical)) throw new Error('项目仍有运行中或正在停止的任务')
  mutations.add(canonical)
  try { return await operation() } finally { mutations.delete(canonical) }
}


export interface ProjectActivityLease { release: () => void; retain: () => () => void }

/** runtime 的实际授权根包含临时附加目录；停止屏障可继续持有引用直到底层 abort 完成。 */
export function registerProjectActivity(roots: readonly string[]): ProjectActivityLease {
  const entry = { roots: [...new Set(roots.map(canonicalProjectPath))], references: 1 }
  assertNoProjectMutation(entry.roots)
  activities.add(entry)
  const releaseReference = (): (() => void) => {
    let released = false
    return () => {
      if (released) return
      released = true
      if (--entry.references === 0) activities.delete(entry)
    }
  }
  const release = releaseReference()
  return { release, retain: () => {
    if (entry.references === 0) return () => {}
    entry.references++
    return releaseReference()
  } }
}

export function hasProjectActivity(root: string): boolean {
  return [...activities].some(entry => entry.roots.some(path => projectPathsOverlap(root, path)))
}
