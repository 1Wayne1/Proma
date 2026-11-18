import { describe, expect, test } from 'bun:test'
import { createStore } from 'jotai'
import { activeViewAtom } from './active-view'
import { activeSessionIdAtom, activeTabIdAtom, tabsAtom, visibleAgentStreamSessionAtom } from './tab-atoms'

describe('前台 Agent 会话', () => {
  test('Given Agent 标签保持选中 When 切换全屏视图 Then 通知主进程撤销并重新登记可见会话', () => {
    const store = createStore()
    store.set(tabsAtom, [{ id: 'agent-tab', type: 'agent', sessionId: 'agent-session', title: '验收' }])
    store.set(activeTabIdAtom, 'agent-tab')
    const changes: Array<string | null> = []
    const unsubscribe = store.sub(visibleAgentStreamSessionAtom, () => changes.push(store.get(visibleAgentStreamSessionAtom)))

    expect(store.get(visibleAgentStreamSessionAtom)).toBe('agent-session')
    store.set(activeViewAtom, 'planning')
    expect(store.get(activeSessionIdAtom)).toBe('agent-session')
    store.set(activeViewAtom, 'conversations')

    expect(changes).toEqual([null, 'agent-session'])
    unsubscribe()
  })
})
