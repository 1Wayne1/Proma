import { expect, test } from 'bun:test'
import type { SDKMessage } from '@proma/shared'
import { resolveRetriedTurnUuid } from './identity'

function user(uuid: string, text = '重复的输入'): SDKMessage { return { type: 'user', uuid, parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'text', text }] } } as SDKMessage }
function assistant(uuid: string): SDKMessage { return { type: 'assistant', uuid, parent_tool_use_id: null, message: { content: [{ type: 'text', text: 'error' }] } } as SDKMessage }

test('Given 两条相同文本的输入 When 重试特定错误 UUID Then 找回对应原输入而非最后一条文本', () => {
  const messages = [user('u1'), assistant('e1'), user('u2'), assistant('e2')]
  expect(resolveRetriedTurnUuid(messages, 'e1', '重复的输入')).toBe('u1')
  expect(resolveRetriedTurnUuid(messages, 'e2', '重复的输入')).toBe('u2')
})
test('Given 工具结果夹在输入与错误间 When 定位重试 Then 工具结果不能成为输入身份', () => {
  const toolResult = { type: 'user', uuid: 'tool-result', message: { content: [{ type: 'tool_result', tool_use_id: 'tool', content: 'done' }] } } as SDKMessage
  expect(resolveRetriedTurnUuid([user('u1'), toolResult, assistant('e1')], 'e1', '重复的输入')).toBe('u1')
})
test('Given 未知错误或孤立回复 When 定位重试 Then 不伪造用户输入 UUID', () => {
  expect(resolveRetriedTurnUuid([user('u1'), assistant('e1')], 'missing', '重复的输入')).toBeUndefined()
  expect(resolveRetriedTurnUuid([assistant('e1')], 'e1', '重复的输入')).toBeUndefined()
})

test('Given 旧错误引用与本次重试文本不一致 When 定位快照归属 Then 不误挂到旧输入', () => {
  expect(resolveRetriedTurnUuid([user('u1', 'old input'), assistant('e1')], 'e1', 'different input')).toBeUndefined()
})
