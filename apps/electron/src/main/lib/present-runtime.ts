import { PRESENT_IPC_CHANNELS } from '@proma/shared'
import { getAgentSessionMeta, isAgentSessionDeleting, resolveAgentCwd } from './agent-session-manager'
import { getAgentWorkspace, getProjectFilesPath, getWorkspaceAttachedDirectories, getWorkspaceAttachedFiles } from './agent-workspace-manager'
import { resolveAgentSessionWorkspacePath } from './config-paths'
import { getMainWindow } from './main-window-store'
import { getSettings } from './settings-service'
import { getVaultConfig, getVaultSummary } from './vault-service'
import { PresentService } from './present-service'

export const presentService = new PresentService(sessionId => {
  const session = getAgentSessionMeta(sessionId)
  if (!session || isAgentSessionDeleting(sessionId)) return
  const workspace = session.workspaceId ? getAgentWorkspace(session.workspaceId) : undefined
  if (session.workspaceId && !workspace) return
  const cwd = workspace ? resolveAgentCwd(workspace, session.id, session.agentCwdMode, session.activeWorktree) : undefined
  const configured = getSettings().productivityTools.obsidianEnabled ? getVaultConfig() : null
  const vault = configured ? getVaultSummary() : null
  return {
    cwd,
    directories: [...new Set([
      ...(session.attachedDirectories ?? []),
      ...(workspace ? [getProjectFilesPath(workspace.slug), resolveAgentSessionWorkspacePath(workspace.slug, session.id), ...getWorkspaceAttachedDirectories(workspace.slug)] : []),
      ...(session.activeWorktree?.path ? [session.activeWorktree.path] : []),
      ...(cwd ? [cwd] : []),
      ...(configured ? [configured.rootPath] : []),
    ])],
    files: [...(session.attachedFiles ?? []), ...(workspace ? getWorkspaceAttachedFiles(workspace.slug) : [])],
    ...(configured && vault && { vault: { path: configured.rootPath, id: vault.vaultId } }),
  }
}, turn => getMainWindow()?.webContents.send(PRESENT_IPC_CHANNELS.CHANGED, turn))
