import { describe, expect, test } from 'bun:test'
import { PROMA_DEFAULT_PERMISSION_MODE } from '@proma/shared'
import { resolveInitialAgentPermissionMode } from './agent-send-message-policy'

describe('Agent 发送请求的初始权限', () => {
  test('旧会话未显式覆盖时沿用保存的计划模式', () => {
    expect(resolveInitialAgentPermissionMode(undefined, 'plan')).toBe('plan')
  })

  test('显式覆盖优先，未保存权限的新会话沿用默认模式', () => {
    expect(resolveInitialAgentPermissionMode('bypassPermissions', 'plan')).toBe('bypassPermissions')
    expect(resolveInitialAgentPermissionMode()).toBe(PROMA_DEFAULT_PERMISSION_MODE)
  })
})
