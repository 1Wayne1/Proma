import type { TurnChangeOwner, TurnChangeRecord, TurnDiffSide, TurnFileDiff, TurnFileSnapshot } from '@proma/shared'
import { TurnChangeStore } from './store'
import { normalizeTurnPath, turnPathKey } from './paths'

export interface TurnSessionOwner { sessionId: string; workspaceId: string }

function request(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('无效的逐轮变更请求')
  const data = input as Record<string, unknown>
  for (const key of ['sessionId', 'turnId']) if (typeof data[key] !== 'string' || !data[key] || data[key].length > 256 || data[key].includes('\0')) throw new Error('无效的逐轮变更请求')
  return data
}

/** 只查询已授权会话的私有快照，不读取 renderer 提供的磁盘路径。 */
export class TurnChangesQueries {
  constructor(private readonly store: TurnChangeStore, private readonly resolveSession: (sessionId: string) => TurnSessionOwner | undefined) {}

  private owner(data: Record<string, unknown>): TurnChangeOwner {
    const session = this.resolveSession(data.sessionId as string)
    if (!session || session.sessionId !== data.sessionId) throw new Error('会话不存在或不可访问')
    return { ...session, turnId: data.turnId as string }
  }

  private recheck(owner: TurnChangeOwner): void {
    const latest = this.resolveSession(owner.sessionId)
    if (!latest || latest.workspaceId !== owner.workspaceId || latest.sessionId !== owner.sessionId) throw new Error('会话已删除或归属已变化')
  }

  async list(input: unknown): Promise<TurnChangeRecord[]> {
    const owner = this.owner(request(input))
    const records = await this.store.list(owner)
    this.recheck(owner)
    // recording 中的 files 是轮初候选快照，尚不能作为“已发生的文件变化”展示。
    return records.map(record => record.completion === 'recording'
      ? { ...record, partial: true, limitations: [...new Set([...record.limitations, 'not-captured' as const])], files: [] }
      : record)
  }

  async diff(input: unknown): Promise<TurnFileDiff> {
    const data = request(input)
    const owner = this.owner(data)
    if (typeof data.recordId !== 'string' || typeof data.path !== 'string') throw new Error('无效的逐轮文件请求')
    const recordId = data.recordId
    const record = await this.store.read(owner, recordId)
    if (record.completion === 'recording') throw new Error('本轮快照尚未收束')
    const key = turnPathKey(normalizeTurnPath(data.path))
    const file = record.files.find(file => turnPathKey(file.path) === key)
    if (!file) throw new Error('此文件不属于指定轮次')
    const side = async (snapshot: TurnFileSnapshot, direction: 'before' | 'after'): Promise<TurnDiffSide> => {
      if (snapshot.availability === 'missing') return { snapshot, content: '' }
      if (snapshot.availability === 'available' && snapshot.format === 'text') return { snapshot, content: await this.store.readText(owner, recordId, file.path, direction) }
      return { snapshot }
    }
    const before = await side(file.before, 'before')
    const after = await side(file.after, 'after')
    this.recheck(owner)
    return { path: file.path, before, after }
  }
}
