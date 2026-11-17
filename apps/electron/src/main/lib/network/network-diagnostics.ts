import { randomUUID } from 'node:crypto'
import type { NetworkDiagnosticPreview, NetworkStatusSnapshot } from '@proma/shared'

/** 只允许导出同一个窗口刚刚预览的不可变快照，且不接受 renderer 提供的报告正文。 */
export class NetworkDiagnosticPreviews {
  private preview: { owner: number; createdAt: number; value: NetworkDiagnosticPreview } | undefined

  constructor(private readonly now: () => number = Date.now) {}

  create(owner: number, snapshot: NetworkStatusSnapshot): NetworkDiagnosticPreview {
    const value: NetworkDiagnosticPreview = {
      previewId: randomUUID(),
      report: { schemaVersion: 1, generatedAt: this.now(), scope: 'main-process-http-and-mcp', snapshot: structuredClone(snapshot) },
    }
    this.preview = { owner, createdAt: this.now(), value }
    return structuredClone(value)
  }

  read(owner: number, previewId: unknown): NetworkDiagnosticPreview {
    const preview = this.preview
    if (typeof previewId !== 'string' || !preview || preview.owner !== owner || preview.value.previewId !== previewId || this.now() - preview.createdAt > 10 * 60_000) {
      throw new Error('诊断预览已失效，请重新预览后导出')
    }
    return structuredClone(preview.value)
  }

  clear(): void { this.preview = undefined }
}
