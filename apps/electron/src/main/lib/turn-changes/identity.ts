import type { SDKMessage } from '@proma/shared'
import { extractUserText, groupIntoTurns } from '@proma/session-core'

/** 重试不追加用户消息；按错误 UUID 找回原输入，不能按重复文本猜测归属。 */
export function resolveRetriedTurnUuid(messages: SDKMessage[], errorUuid: string, expectedText: string): string | undefined {
  for (const group of groupIntoTurns(messages)) {
    if (group.type === 'assistant-turn' && group.assistantMessages.some(message => message.uuid === errorUuid)) {
      // 仅验证已定位输入与本次重试请求一致；不按文本搜索其他输入。
      return group.inputMessage && extractUserText(group.inputMessage) === expectedText ? group.inputMessage.uuid || undefined : undefined
    }
  }
  return undefined
}
