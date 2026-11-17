import { watch as watchNative, existsSync, statSync } from 'node:fs'
import type { FSWatcher } from 'node:fs'
export { existsSync, statSync }
interface Session { id: string; attachedDirectories?: string[]; attachedFiles?: string[]; activeWorktree?: { path: string } }
export const watchHost: { managed: string; sessions: Session[]; watchers: Array<{ path: string; watcher: FSWatcher }> } = { managed: '', sessions: [], watchers: [] }
export function watch(path: string, options: { recursive: boolean }, listener: (event: string, filename: string | Buffer | null) => void): FSWatcher {
  const watcher = watchNative(path, options, listener)
  watchHost.watchers.push({ path, watcher })
  return watcher
}
export const getAgentWorkspacesDir = (): string => watchHost.managed
export const listAgentSessions = (): Session[] => watchHost.sessions
export const listAgentWorkspaces = (): Array<{ id: string; slug: string }> => []
export const getProjectFilesPath = (): string => watchHost.managed
export const getWorkspaceAttachedDirectories = (): string[] => []
export const getWorkspaceAttachedFiles = (): string[] => []
