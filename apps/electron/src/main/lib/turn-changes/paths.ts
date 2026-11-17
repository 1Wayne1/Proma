import { lstat, realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep, win32 } from 'node:path'

export function normalizeTurnPath(value: string): string {
  if (typeof value !== 'string' || !value || value.length > 1024 || value.includes('\0') || isAbsolute(value) || win32.isAbsolute(value) || /^[a-z]:/i.test(value)) throw new Error('无效的逐轮文件相对路径')
  const parts = value.replace(/\\/g, '/').split('/')
  if (parts.some(part => !part || part === '.' || part === '..' || part.includes(':') || /[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part) || part.toLowerCase() === '.git')) throw new Error('逐轮文件路径不能越界、指向特殊设备或 Git 内部数据')
  return parts.join('/')
}

export function isWithinTurnRoot(root: string, target: string): boolean {
  const path = relative(root, target)
  return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`))
}

export function turnPathKey(path: string): string { return process.platform === 'win32' ? path.toLowerCase() : path }

export function uniqueTurnPaths(paths: string[]): string[] {
  const seen = new Set<string>()
  return paths.filter(path => {
    const key = turnPathKey(path)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export async function canonicalTurnRoot(cwd: string): Promise<string> {
  const canonical = await realpath(resolve(cwd))
  if (!(await lstat(canonical)).isDirectory()) throw new Error('逐轮捕获需要有效项目目录')
  return canonical
}

/** 包括不存在文件的最近现存祖先，阻止目录联接将读取引向授权根之外。 */
export async function assertTurnTarget(root: string, path: string): Promise<string> {
  if (await realpath(root) !== root) throw new Error('逐轮捕获项目根已改变')
  const target = resolve(root, normalizeTurnPath(path))
  if (!isWithinTurnRoot(root, target)) throw new Error('逐轮文件路径越界')
  let current = target
  while (true) {
    try {
      const canonical = await realpath(current)
      if (!isWithinTurnRoot(root, canonical)) throw new Error('逐轮文件实际路径越界')
      return target
    } catch (error) {
      if (!isMissingTurnFile(error)) throw error
      const parent = resolve(current, '..')
      if (parent === current || !isWithinTurnRoot(root, parent)) throw new Error('逐轮文件祖先路径越界')
      current = parent
    }
  }
}

export function isMissingTurnFile(error: unknown): boolean {
  return error !== null && typeof error === 'object' && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')
}
