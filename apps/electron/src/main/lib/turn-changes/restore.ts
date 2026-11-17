import { randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import type { TurnChangeOwner, TurnDiffSide, TurnFileDiffQuery, TurnRestoreApplyInput, TurnRestorePreview, TurnRestoreResult, TurnFileChange } from '@proma/shared'
import { withProjectMutation } from '../project-mutation-guard'
import { normalizeTurnPath, turnPathKey } from './paths'
import { TurnChangeStore, validTurnOwner } from './store'
import { assertRestoreRoot, commitRestoreFile, inspectRestoreFile, restoreRootIdentity, sameRestoreContent } from './restore-files'
import type { RestoreFileState, RootIdentity } from './restore-files'

export interface TurnRestoreSession { workspaceId: string; roots: string[]; identity: string }
export interface TurnRestoreOptions {
  resolveSession: (sessionId: string) => TurnRestoreSession | undefined
  authorizeRoot: (sessionId: string, root: string) => Promise<boolean>
  isBusy: (root: string) => boolean
  onRestored?: (owner: TurnChangeOwner, target: string, root: string) => void
  now?: () => number
}
interface Preview {
  owner: TurnChangeOwner
  root: string
  recordId: string
  rootIdentity: RootIdentity
  sessionIdentity: string
  path: string
  current: RestoreFileState
  target?: Buffer
  maxBytes: number
  expiresAt: number
}

function textSide(snapshot: TurnDiffSide['snapshot'], bytes?: Buffer): TurnDiffSide {
  return { snapshot, ...(snapshot.availability === 'missing' ? { content: '' } : snapshot.format === 'text' && bytes ? { content: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) } : {}) }
}

/** 单文件、一次性、短期预览。文件正文和绝对路径均由主进程私有快照决定。 */
export class TurnRestoreService {
  private readonly previews = new Map<string, Preview>()
  constructor(private readonly store: TurnChangeStore, private readonly options: TurnRestoreOptions) {}
  private now(): number { return this.options.now?.() ?? Date.now() }
  clear(): void { this.previews.clear() }
  invalidateSession(sessionId: string): void { for (const [id, preview] of this.previews) if (preview.owner.sessionId === sessionId) this.previews.delete(id) }

  private session(owner: TurnChangeOwner, root: string, identity?: string): TurnRestoreSession {
    const session = this.options.resolveSession(owner.sessionId)
    if (!session || session.workspaceId !== owner.workspaceId || identity !== undefined && session.identity !== identity
      || !session.roots.some(path => { try { return turnPathKey(realpathSync(path)) === turnPathKey(root) } catch { return false } })) throw new Error('会话归属或授权项目已改变')
    return session
  }

  async preview(input: TurnFileDiffQuery): Promise<TurnRestorePreview> {
    if (!input || typeof input.sessionId !== 'string' || typeof input.turnId !== 'string' || typeof input.recordId !== 'string' || typeof input.path !== 'string') throw new Error('无效的恢复预览请求')
    const session = this.options.resolveSession(input.sessionId)
    const owner = { sessionId: input.sessionId, turnId: input.turnId, workspaceId: session?.workspaceId ?? '' }
    if (!validTurnOwner(owner)) throw new Error('会话不可访问')
    const path = normalizeTurnPath(input.path)
    const record = await this.store.read(owner, input.recordId)
    if (record.completion === 'recording') return { path, status: 'unavailable', reason: '本轮尚未收束' }
    const file: TurnFileChange | undefined = record.files.find(file => turnPathKey(file.path) === turnPathKey(path))
    if (!file) throw new Error('文件不属于指定轮次')
    if (file.before.availability === 'omitted' || file.after.availability === 'omitted') return { path, status: 'unavailable', reason: '前后快照不完整，不能据此恢复' }
    const context = this.session(owner, record.canonicalCwd)
    const rootIdentity = restoreRootIdentity(record.canonicalCwd)
    if (!await this.options.authorizeRoot(owner.sessionId, record.canonicalCwd)) throw new Error('项目授权已失效')
    this.session(owner, record.canonicalCwd, context.identity)
    if (this.options.isBusy(record.canonicalCwd)) return { path, status: 'busy', reason: '项目有正在启动或运行的任务、队列或终端，请结束后再恢复' }
    const target = file.before.availability === 'available' ? await this.store.readBytes(owner, record.recordId, file.path, 'before') : undefined
    this.session(owner, record.canonicalCwd, context.identity)
    assertRestoreRoot(record.canonicalCwd, rootIdentity)
    const current = inspectRestoreFile(record.canonicalCwd, file.path, record.limits.maxFileBytes)
    if (!sameRestoreContent(current.snapshot, file.after)) return { path, status: 'conflict', reason: '当前文件与本轮结束快照不同，保留后续编辑；请检查后重新处理' }
    if (sameRestoreContent(current.snapshot, file.before)) return { path, status: 'unavailable', reason: '文件已经处于修改前状态' }
    for (const [id, preview] of this.previews) if (preview.expiresAt <= this.now()) this.previews.delete(id)
    while (this.previews.size >= 8) this.previews.delete(this.previews.keys().next().value!)
    const previewId = randomUUID()
    const expiresAt = this.now() + 60_000
    this.previews.set(previewId, { owner, root: record.canonicalCwd, recordId: record.recordId, rootIdentity, sessionIdentity: context.identity, path: file.path, current, target, maxBytes: record.limits.maxFileBytes, expiresAt })
    return { path: file.path, status: 'ready', previewId, expiresAt, action: target === undefined ? 'delete' : 'write', source: file.source,
      diff: { path: file.path, before: textSide(current.snapshot, current.bytes), after: textSide(file.before, target) } }
  }

  async apply(input: TurnRestoreApplyInput, assertCurrent: () => void = () => {}): Promise<TurnRestoreResult> {
    if (!input || typeof input.previewId !== 'string' || typeof input.sessionId !== 'string' || typeof input.turnId !== 'string') throw new Error('无效的恢复请求')
    const preview = this.previews.get(input.previewId)
    if (!preview || preview.owner.sessionId !== input.sessionId || preview.owner.turnId !== input.turnId) return { status: 'expired', reason: '预览不存在或不属于当前会话，请重新预览' }
    this.previews.delete(input.previewId)
    if (preview.expiresAt <= this.now()) return { status: 'expired', path: preview.path, reason: '恢复预览已过期，请重新预览' }
    try {
      return await withProjectMutation(preview.root, async () => {
        const check = (): void => {
          assertCurrent()
          this.session(preview.owner, preview.root, preview.sessionIdentity)
          assertRestoreRoot(preview.root, preview.rootIdentity)
          if (this.options.isBusy(preview.root)) throw new Error('项目有活动任务或终端')
        }
        check()
        const record = await this.store.read(preview.owner, preview.recordId)
        if (record.canonicalCwd !== preview.root || record.completion === 'recording') throw new Error('快照记录已失效')
        if (!await this.options.authorizeRoot(input.sessionId, preview.root)) throw new Error('项目授权已失效')
        check()
        const latest = inspectRestoreFile(preview.root, preview.path, preview.maxBytes)
        if (latest.identity !== preview.current.identity || latest.parents !== preview.current.parents || !sameRestoreContent(latest.snapshot, preview.current.snapshot)) return { status: 'conflict', path: preview.path, reason: '文件已在预览后改变，未执行恢复' }
        commitRestoreFile(preview.root, preview.path, preview.current, preview.target, preview.maxBytes, check)
        try { this.options.onRestored?.(preview.owner, preview.path, preview.root) } catch { /* 通知失败不改变已完成的落盘结果。 */ }
        return { status: 'restored', path: preview.path }
      })
    } catch {
      return { status: this.options.isBusy(preview.root) ? 'busy' : 'failed', path: preview.path, reason: '恢复未完成，目标身份、权限或文件状态可能已改变；请重新预览' }
    }
  }
}
