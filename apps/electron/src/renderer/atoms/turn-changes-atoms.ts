import { atom } from 'jotai'
import type { TurnChangeRecord, TurnChangesQuery, TurnFileDiff, TurnFileDiffQuery } from '@proma/shared'

export interface TurnChangesViewState {
  records: TurnChangeRecord[]
  loading: boolean
  error: string | null
  selectedRecordId: string | null
  selectedPath: string | null
  diff: TurnFileDiff | null
  diffLoading: boolean
  diffError: string | null
  viewMode: 'split' | 'unified'
}

export function createTurnChangesViewAtom() {
  return atom<TurnChangesViewState>({ records: [], loading: false, error: null, selectedRecordId: null, selectedPath: null, diff: null, diffLoading: false, diffError: null, viewMode: 'unified' })
}

interface Client {
  getTurnChanges: (input: TurnChangesQuery) => Promise<TurnChangeRecord[]>
  getTurnFileDiff: (input: TurnFileDiffQuery) => Promise<TurnFileDiff>
}

/** 请求代次绑定到面板的会话/轮次；卸载、重载或切换文件后忽略旧响应。 */
export function createTurnChangesController(client: Client, owner: TurnChangesQuery, update: (patch: Partial<TurnChangesViewState>) => void) {
  let disposed = false
  let revision = 0
  let fileRevision = 0
  const selectRecord = (id: string): void => {
    fileRevision += 1
    if (!disposed) update({ selectedRecordId: id, selectedPath: null, diff: null, diffLoading: false, diffError: null })
  }
  return {
    selectRecord,
    async load(): Promise<void> {
      if (disposed) return
      const current = ++revision
      fileRevision += 1
      update({ loading: true, error: null, diff: null, selectedPath: null, diffLoading: false, diffError: null })
      try {
        const records = await client.getTurnChanges(owner)
        if (!disposed && current === revision) {
          fileRevision += 1
          update({ records, loading: false, selectedRecordId: records[0]?.recordId ?? null, selectedPath: null, diff: null, diffLoading: false, diffError: null })
        }
      } catch { if (!disposed && current === revision) update({ loading: false, error: '无法读取本轮变更，请重试' }) }
    },
    async loadDiff(recordId: string, path: string): Promise<void> {
      if (disposed) return
      const current = ++fileRevision
      update({ selectedRecordId: recordId, selectedPath: path, diff: null, diffLoading: true, diffError: null })
      try {
        const diff = await client.getTurnFileDiff({ ...owner, recordId, path })
        if (!disposed && current === fileRevision) update({ diff, diffLoading: false })
      } catch { if (!disposed && current === fileRevision) update({ diffLoading: false, diffError: '快照读取失败，请重试；不会改为读取当前磁盘文件' }) }
    },
    dispose(): void { disposed = true; revision += 1; fileRevision += 1 },
  }
}
