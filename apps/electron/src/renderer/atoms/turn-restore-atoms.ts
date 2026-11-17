import { atom } from 'jotai'
import type { TurnFileDiffQuery, TurnRestoreApplyInput, TurnRestorePreview, TurnRestoreResult } from '@proma/shared'

export interface TurnRestoreState {
  preview: TurnRestorePreview | null
  result: TurnRestoreResult | null
  pending: 'preview' | 'apply' | null
  error: string | null
}
export function createTurnRestoreAtom() { return atom<TurnRestoreState>({ preview: null, result: null, pending: null, error: null }) }
interface Client {
  previewTurnRestore: (input: TurnFileDiffQuery) => Promise<TurnRestorePreview>
  applyTurnRestore: (input: TurnRestoreApplyInput) => Promise<TurnRestoreResult>
}

/** token 只可由当前文件的本次预览产生；取消、卸载和旧响应不能重新激活确认。 */
export function createTurnRestoreController(client: Client, file: TurnFileDiffQuery, update: (patch: Partial<TurnRestoreState>) => void) {
  let disposed = false
  let revision = 0
  let pending: 'preview' | 'apply' | null = null
  let ready: TurnRestorePreview | null = null
  return {
    async preview(): Promise<void> {
      if (disposed || pending) return
      const current = ++revision
      pending = 'preview'
      ready = null
      update({ pending, preview: null, result: null, error: null })
      try {
        const preview = await client.previewTurnRestore(file)
        if (!disposed && current === revision) { ready = preview.status === 'ready' ? preview : null; update({ preview, pending: null }) }
      } catch { if (!disposed && current === revision) update({ pending: null, error: '无法预览恢复，请确认项目和快照仍然可用后重试' }) }
      finally { if (current === revision) pending = null }
    },
    async apply(): Promise<void> {
      if (disposed || pending || !ready?.previewId) return
      const previewId = ready.previewId
      ready = null
      const current = ++revision
      pending = 'apply'
      update({ pending, error: null })
      try {
        const result = await client.applyTurnRestore({ sessionId: file.sessionId, turnId: file.turnId, previewId })
        if (!disposed && current === revision) update({ result, preview: null, pending: null })
      } catch { if (!disposed && current === revision) update({ pending: null, preview: null, error: '恢复结果未能确认，请检查当前文件并重新预览；不会自动重放写入' }) }
      finally { if (current === revision) pending = null }
    },
    cancel(): void {
      if (pending === 'apply' || disposed) return
      revision++; ready = null; pending = null
      update({ preview: null, pending: null, error: null })
    },
    dispose(): void { disposed = true; revision++; ready = null },
  }
}
