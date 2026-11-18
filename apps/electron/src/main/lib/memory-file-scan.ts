import { lstatSync, opendirSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { isMissingTurnFile, turnPathKey } from './turn-changes/paths'

const MAX_ENTRIES = 256
const MAX_DEPTH = 7

/** 只扫描显式子目录；目录链接或文件链接作为条目返回，不跟随它们。 */
export function scanMemoryFiles(root: string, directory: string, maxDepth = MAX_DEPTH): { paths: string[]; partial: boolean } {
  const paths: string[] = []
  let partial = false
  let observed = 0

  function visit(path: string, depth: number): void {
    if (observed >= MAX_ENTRIES || depth > maxDepth) { partial = true; return }
    const absolute = join(root, path)
    let stat
    try { stat = lstatSync(absolute) } catch (error) {
      if (isMissingTurnFile(error)) return
      throw error
    }
    if (!stat.isDirectory() || turnPathKey(realpathSync(absolute)) !== turnPathKey(absolute)) {
      paths.push(path)
      return
    }
    const dir = opendirSync(absolute)
    try {
      let entry = dir.readSync()
      while (entry) {
        if (++observed > MAX_ENTRIES) { partial = true; break }
        const child = `${path}/${entry.name}`
        if (entry.isDirectory()) visit(child, depth + 1)
        else paths.push(child)
        if (observed >= MAX_ENTRIES) { partial = true; break }
        entry = dir.readSync()
      }
    } finally { dir.closeSync() }
  }

  visit(directory, 0)
  return { paths: paths.sort(), partial }
}
