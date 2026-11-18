export const DESKTOP_PREVIEW_IPC = {
  state: 'desktop-preview:state', changed: 'desktop-preview:changed', command: 'desktop-preview:command',
} as const

export interface DesktopPreviewState {
  sessionId: string
  id: string
  title: string
  mode: 'live' | 'snapshot'
  error?: string
}
export interface DesktopPreviewCommand {
  sessionId: string
  id: string
  action: 'frame' | 'retry' | 'activate' | 'stop'
}
export interface DesktopPreviewFrame { id: string; png: string; delayMs: number }
