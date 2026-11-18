import { createHash, randomUUID } from 'node:crypto'
import { lstatSync, realpathSync, rmSync } from 'node:fs'
import { basename, extname, isAbsolute, join, relative, resolve, sep, win32 } from 'node:path'
import type { PresentTurn, PresentedResource, VaultPresentation } from '@proma/shared'
import { getConfigDir } from './config-paths'
import { isMissingTurnFile, turnPathKey } from './turn-changes/paths'
import { assertRestoreRoot, commitRestoreFile, inspectRestoreFile, restoreRootIdentity } from './turn-changes/restore-files'

const MAX_FILES = 20
const MAX_RECORD_BYTES = 512 * 1024
const DISPLAY_TIMEOUT = 45_000

export interface PresentAuthority {
  cwd?: string
  directories: string[]
  files: string[]
  vault?: { path: string; id: string }
}

interface FileProof {
  path: string
  identity: string
  boundary: string
  boundaryIdentity: string
  directory: boolean
}

interface StoredResource extends FileProof {
  id: string
  description?: string
  status: 'pending' | 'presented' | 'cancelled'
}

interface StoredTurn extends PresentTurn {
  version: 1
  resources: StoredResource[]
}

export interface PresentAttempt {
  id: string
  owner: PresentTurn
  resource: StoredResource
  signal: AbortSignal
  vault?: VaultPresentation
}

interface RunningAttempt extends PresentAttempt {
  destination: 'open' | 'locate' | 'vault' | 'browser'
  abort: AbortController
  timer: ReturnType<typeof setTimeout>
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function isWithin(root: string, path: string): boolean {
  const rel = relative(turnPathKey(root), turnPathKey(path))
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`))
}

function identity(path: string, directory: boolean): string {
  const stat = lstatSync(path)
  if (directory ? !stat.isDirectory() : !stat.isFile()) throw new Error('展示目标不是普通文件或目录')
  return directory
    ? JSON.stringify([stat.dev, stat.ino])
    : JSON.stringify([stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs])
}

function findAuthority(path: string, authority: PresentAuthority): FileProof {
  const actualPath = realpathSync(path)
  const fileIdentity = identity(actualPath, false)
  for (const directory of authority.directories) {
    try {
      const boundary = realpathSync(directory)
      if (turnPathKey(resolve(directory)) !== turnPathKey(boundary) || !isWithin(boundary, actualPath)) continue
      return { path: actualPath, identity: fileIdentity, boundary, boundaryIdentity: identity(boundary, true), directory: true }
    } catch {}
  }
  for (const file of authority.files) {
    try {
      if (turnPathKey(resolve(file)) === turnPathKey(actualPath) && turnPathKey(realpathSync(file)) === turnPathKey(actualPath)) {
        return { path: actualPath, identity: fileIdentity, boundary: actualPath, boundaryIdentity: fileIdentity, directory: false }
      }
    } catch {}
  }
  throw new Error('文件超出当前会话的展示授权范围')
}

function vaultPath(path: string, authority: PresentAuthority): { id: string; relativePath: string } | undefined {
  const vault = authority.vault
  if (!vault || !path.toLowerCase().endsWith('.md')) return
  try {
    const root = realpathSync(vault.path)
    if (!isWithin(root, path)) return
    const relativePath = relative(root, path).split(sep).join('/')
    if (relativePath.split('/').some(segment => !segment || segment.startsWith('.'))) return
    return { id: vault.id, relativePath }
  } catch { return undefined }
}

export class PresentService {
  private readonly running = new Map<string, RunningAttempt>()

  constructor(
    private readonly resolveAuthority: (sessionId: string) => PresentAuthority | undefined,
    private readonly changed: (turn: PresentTurn) => void,
    private readonly configRoot = getConfigDir,
  ) {}

  declare(owner: PresentTurn, files: Array<{ path: string; description?: string }>): PresentedResource[] {
    if (!Array.isArray(files) || !files.length || files.length > MAX_FILES) throw new Error('一次可声明 1 到 20 个现有文件')
    const authority = this.authority(owner.sessionId)
    const record = this.read(owner)
    const resources = new Map(record.resources.map(resource => [resource.id, resource]))
    const requestedIds = new Set<string>()
    const superseded: RunningAttempt[] = []
    // 先验证所有输入；一项越界时不留下部分声明。
    for (const file of files) {
      if (typeof file?.path !== 'string' || !file.path.trim() || file.path.length > 4096 || file.path.includes('\0')) throw new Error('无效的交付文件路径')
      if (file.description !== undefined && (typeof file.description !== 'string' || file.description.length > 500)) throw new Error('交付说明不能超过 500 个字符')
      if (!isAbsolute(file.path) && (win32.isAbsolute(file.path) || /^[a-z]:/i.test(file.path) || !authority.cwd)) throw new Error('交付文件需位于当前会话的授权路径')
      const proof = findAuthority(resolve(authority.cwd ?? '', file.path), authority)
      const id = hash(turnPathKey(proof.path))
      const previous = resources.get(id)
      const unchanged = previous?.identity === proof.identity && previous.boundaryIdentity === proof.boundaryIdentity && previous.boundary === proof.boundary
      if (!unchanged) {
        const active = this.running.get(this.attemptKey(owner, id))
        if (active) superseded.push(active)
      }
      resources.set(id, { ...proof, id, description: file.description?.trim() || previous?.description, status: unchanged ? previous.status : 'pending' })
      requestedIds.add(id)
    }
    if (resources.size > MAX_FILES) throw new Error('同一轮次最多保留 20 个交付文件')
    this.write(owner, [...resources.values()])
    for (const attempt of superseded) this.finishAttempt(attempt)
    return this.list(owner).filter(item => requestedIds.has(item.id))
  }

  list(owner: PresentTurn): PresentedResource[] {
    const resources = this.read(owner).resources
    if (!resources.length) return []
    const authority = this.authority(owner.sessionId)
    return resources.map(resource => {
      const available = this.isAvailable(resource, authority)
      return {
        id: resource.id, name: basename(resource.path), extension: extname(resource.path).slice(1).toLowerCase(),
        description: resource.description,
        status: available ? this.running.has(this.attemptKey(owner, resource.id)) ? 'opening' : resource.status : 'unavailable',
        browserAvailable: available && resource.directory && /\.html?$/i.test(resource.path),
        vaultAvailable: available && !!vaultPath(resource.path, authority),
      }
    })
  }

  begin(owner: PresentTurn, resourceId: string, destination: 'open' | 'locate' | 'vault' | 'browser'): PresentAttempt {
    const authority = this.authority(owner.sessionId)
    const resource = this.read(owner).resources.find(item => item.id === resourceId)
    if (!resource || !this.isAvailable(resource, authority)) throw new Error('交付文件已变化、被移除或失去授权')
    const key = this.attemptKey(owner, resourceId)
    const existing = this.running.get(key)
    if (existing && (existing.destination !== destination || (destination !== 'vault' && destination !== 'browser'))) {
      throw new Error('此文件正在打开')
    }
    const vault = destination === 'vault' ? vaultPath(resource.path, authority) : undefined
    if (destination === 'vault' && !vault) throw new Error('此文件不属于当前 Vault')
    if (destination === 'browser' && (!resource.directory || !/\.html?$/i.test(resource.path))) throw new Error('此文件不能在受管浏览器显示')
    if (destination === 'vault' || destination === 'browser') {
      for (const current of this.running.values()) {
        if (current.owner.sessionId === owner.sessionId && current.destination === destination) this.settle(current, 'cancelled')
      }
    }
    const id = randomUUID()
    const abort = new AbortController()
    const timer = setTimeout(() => {
      try { this.settle(attempt, 'cancelled') } catch { /* 授权失效时仍释放请求资源。 */ }
    }, DISPLAY_TIMEOUT)
    timer.unref()
    const attempt: RunningAttempt = {
      id, owner, resource, destination, abort, timer, signal: abort.signal,
      ...(vault && { vault: { ...owner, requestId: id, vaultId: vault.id, relativePath: vault.relativePath } }),
    }
    this.running.set(key, attempt)
    this.notify(owner)
    return attempt
  }

  verify(attempt: PresentAttempt): string {
    const authority = this.authority(attempt.owner.sessionId)
    if (attempt.signal.aborted || !this.isAvailable(attempt.resource, authority)) throw new Error('展示请求已取消或文件已变化')
    const current = this.read(attempt.owner).resources.find(item => item.id === attempt.resource.id)
    if (current?.identity !== attempt.resource.identity || current.boundary !== attempt.resource.boundary || current.boundaryIdentity !== attempt.resource.boundaryIdentity) {
      throw new Error('交付文件已有新版，请重新打开')
    }
    if (attempt.vault && vaultPath(attempt.resource.path, authority)?.id !== attempt.vault.vaultId) throw new Error('Vault 已切换')
    return attempt.resource.path
  }

  settle(attempt: PresentAttempt, outcome: 'presented' | 'cancelled'): boolean {
    const key = this.attemptKey(attempt.owner, attempt.resource.id)
    const active = this.running.get(key)
    if (!active || active.id !== attempt.id) return false
    this.running.delete(key)
    clearTimeout(active.timer)
    try {
      if (outcome === 'presented') this.verify(attempt)
      if (this.resolveAuthority(attempt.owner.sessionId)) {
        const record = this.read(attempt.owner)
        this.write(attempt.owner, record.resources.map(resource => resource.id === attempt.resource.id && resource.identity === attempt.resource.identity
          ? { ...resource, status: outcome } : resource))
      }
    } catch (error) {
      active.abort.abort()
      throw error
    } finally {
      if (outcome === 'cancelled') active.abort.abort()
      this.notify(attempt.owner)
    }
    return true
  }

  vaultReceipt(owner: PresentTurn, requestId: string, outcome: 'presented' | 'cancelled'): boolean {
    const attempt = [...this.running.values()].find(candidate => candidate.id === requestId && candidate.vault
      && candidate.owner.sessionId === owner.sessionId && candidate.owner.turnId === owner.turnId)
    return attempt ? this.settle(attempt, outcome) : false
  }

  cancel(owner: PresentTurn, resourceId: string): void {
    this.authority(owner.sessionId)
    const active = this.running.get(this.attemptKey(owner, resourceId))
    if (active) { this.settle(active, 'cancelled'); return }
    const record = this.read(owner)
    if (record.resources.some(resource => resource.id === resourceId && resource.status === 'pending')) {
      this.write(owner, record.resources.map(resource => resource.id === resourceId ? { ...resource, status: 'cancelled' } : resource))
    }
  }

  releaseSession(sessionId: string): void {
    for (const attempt of this.running.values()) {
      if (attempt.owner.sessionId !== sessionId) continue
      try { this.settle(attempt, 'cancelled') } catch { /* 失效会话无需写回。 */ }
    }
  }

  purgeSession(sessionId: string): void {
    this.releaseSession(sessionId)
    // 仅清理该会话哈希命名的私有记录目录。
    const root = realpathSync(this.configRoot())
    const parent = join(root, 'present')
    const path = join(parent, hash(sessionId))
    try {
      if (!lstatSync(parent).isDirectory() || realpathSync(parent) !== parent || !lstatSync(path).isDirectory()) return
      rmSync(path, { recursive: true, force: true })
    } catch (error) { if (!isMissingTurnFile(error)) throw error }
  }

  private finishAttempt(attempt: RunningAttempt): void {
    const key = this.attemptKey(attempt.owner, attempt.resource.id)
    if (this.running.get(key) !== attempt) return
    this.running.delete(key)
    clearTimeout(attempt.timer)
    attempt.abort.abort()
    this.notify(attempt.owner)
  }

  private authority(sessionId: string): PresentAuthority {
    const authority = this.resolveAuthority(sessionId)
    if (!authority) throw new Error('会话不存在或已失去展示授权')
    return authority
  }

  private isAvailable(resource: FileProof, authority: PresentAuthority): boolean {
    try {
      if (!isAbsolute(resource.path) || !isAbsolute(resource.boundary) || (resource.directory
        ? !isWithin(resource.boundary, resource.path)
        : turnPathKey(resource.path) !== turnPathKey(resource.boundary))) return false
      if (turnPathKey(realpathSync(resource.path)) !== turnPathKey(resource.path) || identity(resource.path, false) !== resource.identity) return false
      const allowed = resource.directory ? authority.directories : authority.files
      return allowed.some(path => {
        try { return turnPathKey(resolve(path)) === turnPathKey(resource.boundary)
          && turnPathKey(realpathSync(path)) === turnPathKey(resource.boundary)
          && identity(resource.boundary, resource.directory) === resource.boundaryIdentity }
        catch { return false }
      })
    } catch { return false }
  }

  private attemptKey(owner: PresentTurn, id: string): string {
    return JSON.stringify([owner.sessionId, owner.turnId, id])
  }

  private location(owner: PresentTurn) {
    const root = realpathSync(this.configRoot())
    const path = `present/${hash(owner.sessionId)}/${hash(owner.turnId)}.json`
    return { root, path, state: inspectRestoreFile(root, path, MAX_RECORD_BYTES) }
  }

  private read(owner: PresentTurn): StoredTurn {
    const { state } = this.location(owner)
    if (!state.bytes) return { version: 1, ...owner, resources: [] }
    const record = JSON.parse(state.bytes.toString('utf8')) as StoredTurn
    if (record?.version !== 1 || record.sessionId !== owner.sessionId || record.turnId !== owner.turnId
      || !Array.isArray(record.resources) || record.resources.length > MAX_FILES) throw new Error('交付记录损坏')
    if (record.resources.some(resource => !resource || typeof resource.path !== 'string' || typeof resource.boundary !== 'string' ||
      typeof resource.identity !== 'string' || typeof resource.boundaryIdentity !== 'string' || typeof resource.directory !== 'boolean' ||
      resource.id !== hash(turnPathKey(resource.path)) || !['pending', 'presented', 'cancelled'].includes(resource.status) ||
      (resource.description !== undefined && typeof resource.description !== 'string'))) throw new Error('交付资源记录损坏')
    return record
  }

  private write(owner: PresentTurn, resources: StoredResource[]): void {
    const { root, path, state } = this.location(owner)
    const identity = restoreRootIdentity(root)
    const body = Buffer.from(JSON.stringify({ version: 1, sessionId: owner.sessionId, turnId: owner.turnId, resources }))
    if (body.length > MAX_RECORD_BYTES) throw new Error('交付记录超过容量上限')
    commitRestoreFile(root, path, state, body, MAX_RECORD_BYTES, () => assertRestoreRoot(root, identity))
    this.notify(owner)
  }

  private notify(owner: PresentTurn): void {
    try { this.changed({ sessionId: owner.sessionId, turnId: owner.turnId }) } catch { /* 广播失败不回滚落盘。 */ }
  }
}
