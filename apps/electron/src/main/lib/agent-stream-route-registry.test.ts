import { expect, test } from 'bun:test'
import { AgentStreamRouteRegistry } from './agent-stream-route-registry'

test('Given 原窗口关闭并重建 When 重绑连接与下一轮开始 Then 路由延续原所有者且旧轮无法清理新轮', () => {
  const registry = new AgentStreamRouteRegistry()
  let destroyed = false
  const original = { isDestroyed: () => destroyed }
  const replacement = { isDestroyed: () => false }
  const first = registry.bind('session', original)
  destroyed = true
  expect(registry.get('session')).toBeUndefined()
  expect(registry.rebind('session', replacement).ownerId).toBe(first.ownerId)
  expect(registry.getTargetIfOwner('session', first.ownerId)).toBe(replacement)
  expect(registry.markTargetDestroyed(original)).toEqual([])
  const next = registry.bind('session', replacement)
  expect(registry.removeIfOwner('session', first.ownerId)).toBe(false)
  expect(registry.removeIfOwner('session', next.ownerId)).toBe(true)
  expect(registry.get('session')).toBeUndefined()
})
