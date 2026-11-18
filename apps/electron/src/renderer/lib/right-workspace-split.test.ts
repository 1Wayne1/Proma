import { describe, expect, test } from 'bun:test'
import { sanitizeRightWorkspaceSplit } from './right-workspace-split'
import type { RightWorkspaceSplitState } from './right-workspace-split'
import type { AgentSidePanelTab } from '@/atoms/agent-atoms'

const split: RightWorkspaceSplitState = { leftTab: 'skills', rightTab: 'mcp', focusedPane: 'right', ratio: 0.5 }
const browserTab = 'browser:preview'

describe('右侧并排工作区的焦点同步', () => {
  test('Given MCP 和 Skills 并排 When 从交付卡打开浏览器 Then 在当前区域打开并保留另一个标签', () => {
    const available = new Set<AgentSidePanelTab>(['files', 'skills', 'mcp', browserTab])
    expect(sanitizeRightWorkspaceSplit(split, available, browserTab)).toEqual({
      split: { ...split, rightTab: browserTab }, activeTab: browserTab,
    })
  })

  test('Given 目标在另一个区域 When 请求聚焦 Then 保留两个标签并切换焦点', () => {
    const available = new Set<AgentSidePanelTab>(['files', 'skills', 'mcp'])
    expect(sanitizeRightWorkspaceSplit(split, available, 'skills')).toEqual({
      split: { ...split, focusedPane: 'left' }, activeTab: 'skills',
    })
  })

  test('Given 焦点请求的标签已关闭 When 同步 Then 修复失效区域并保留另一个标签', () => {
    const available = new Set<AgentSidePanelTab>(['files', 'skills'])
    expect(sanitizeRightWorkspaceSplit({ ...split, rightTab: browserTab }, available, browserTab)).toEqual({
      split: { ...split, rightTab: 'files' }, activeTab: 'files',
    })
  })
})
