import { Type } from 'typebox'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { PresentTurn } from '@proma/shared'
import type { PresentService } from '../present-service'

export function buildPiPresentTool(service: PresentService, currentTurn: () => PresentTurn | undefined): ToolDefinition {
  return {
    name: 'Present',
    label: '交付文件',
    description: '在当前回复附上已完成、位于会话授权范围内的文件。可提供简短说明。用户可随后打开、定位或取消交付卡片；此调用只登记现有文件。',
    parameters: Type.Object({
      files: Type.Array(Type.Object({
        path: Type.String({ minLength: 1, maxLength: 4096 }),
        description: Type.Optional(Type.String({ maxLength: 500 })),
      }), { minItems: 1, maxItems: 20 }),
    }),
    async execute(_toolCallId, input, signal) {
      const owner = currentTurn()
      if (!owner || signal?.aborted) throw new Error('本轮已结束或没有可关联的用户输入')
      if (!input || typeof input !== 'object' || !('files' in input) || !Array.isArray(input.files)) {
        throw new Error('请提供要交付的文件列表')
      }
      const files = service.declare(owner, input.files)
      return { content: [{ type: 'text', text: JSON.stringify(files) }], details: {} }
    },
  }
}
