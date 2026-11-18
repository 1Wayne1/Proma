import { lstat, readFile } from 'node:fs/promises'
import { isAbsolute, join, relative } from 'node:path'
import { collectSkillActivations } from '@proma/shared'
import type { AgentWorkspace, SDKMessage, WorkspaceSkillUsage } from '@proma/shared'
import { listAgentSessions } from './agent-session-manager'
import { getAgentSessionMessagesPath, getWorkspaceSkillsDir } from './config-paths'

const MAX_SESSIONS = 400
const MAX_SESSION_BYTES = 16 * 1024 * 1024
const requests = new Map<string, Promise<WorkspaceSkillUsage>>()

export function workspaceSkillsUsedInSession(messages: SDKMessage[], workspaceSlug: string, skillsRoot: string): Set<string> {
  return new Set(collectSkillActivations(messages, {
    includeActivation: item => {
      if (item.slug === '.' || item.slug === '..' || /[/\\]/.test(item.slug)) return false
      if (item.workspaceSlug) return item.workspaceSlug === workspaceSlug
      return !!item.filePath && isAbsolute(item.filePath) && relative(join(skillsRoot, item.slug, 'SKILL.md'), item.filePath) === ''
    },
  }).map(activation => activation.slug))
}

async function readSession(sessionId: string): Promise<{ messages: SDKMessage[]; partial: boolean }> {
  if (!/^[a-z\d_-]{1,128}$/i.test(sessionId)) return { messages: [], partial: true }
  try {
    const path = getAgentSessionMessagesPath(sessionId)
    const stats = await lstat(path)
    if (!stats.isFile() || stats.size > MAX_SESSION_BYTES) return { messages: [], partial: true }
    const raw = await readFile(path, 'utf8')
    const messages: SDKMessage[] = []
    let partial = false
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue
      try {
        const entry: unknown = JSON.parse(line)
        if (entry && typeof entry === 'object' && 'type' in entry) messages.push(entry as SDKMessage)
      } catch {
        partial = true
      }
    }
    return { messages, partial }
  } catch (error) {
    return { messages: [], partial: (error as NodeJS.ErrnoException).code !== 'ENOENT' }
  }
}

async function collectUsage(workspace: AgentWorkspace): Promise<WorkspaceSkillUsage> {
  const sessions = listAgentSessions().filter(session => session.workspaceId === workspace.id)
  const counts = new Map<string, number>()
  let partial = sessions.length > MAX_SESSIONS
  const skillsRoot = getWorkspaceSkillsDir(workspace.slug)
  for (let start = 0; start < Math.min(sessions.length, MAX_SESSIONS); start += 4) {
    const batch = await Promise.all(sessions.slice(start, start + 4).map(session => readSession(session.id)))
    for (const source of batch) {
      partial ||= source.partial
      for (const slug of workspaceSkillsUsedInSession(source.messages, workspace.slug, skillsRoot)) {
        counts.set(slug, (counts.get(slug) ?? 0) + 1)
      }
    }
  }
  return { sessionsBySlug: Object.fromEntries(counts), partial }
}

export function getWorkspaceSkillUsage(workspace: AgentWorkspace): Promise<WorkspaceSkillUsage> {
  const pending = requests.get(workspace.id)
  if (pending) return pending
  const request = collectUsage(workspace).finally(() => { requests.delete(workspace.id) })
  requests.set(workspace.id, request)
  return request
}
