import { Type } from 'typebox'
import type { Static, TSchema } from 'typebox'
import { Check } from 'typebox/value'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import { PROMA_SELF_SCREENSHOT_TOOL, PROMA_SELF_SEARCH_KEYS } from '../../../types/proma-self-control'
import type { PromaSelfForegroundAccess } from '../proma-self-access'
import { assertPromaSelfExecution } from '../proma-self-control-policy'
import type { PromaSelfExecution } from '../proma-self-control-policy'
import { promaSelfController } from '../proma-self-controller'
import type { PromaSelfController } from '../proma-self-controller'

const toolNames = {
  observe: 'PromaSelfObserve',
  find: 'PromaSelfFind',
  click: 'PromaSelfClick',
  fill: 'PromaSelfFill',
  press: 'PromaSelfPress',
  scroll: 'PromaSelfScroll',
  waitFor: 'PromaSelfWaitFor',
  screenshot: PROMA_SELF_SCREENSHOT_TOOL,
} as const
const selfToolNames = new Set<string>(Object.values(toolNames))

export function isPromaSelfTool(name: string): boolean {
  return selfToolNames.has(name)
}

interface PromaSelfToolAccess extends PromaSelfForegroundAccess {
  sessionId: string
}

type SelfController = Pick<PromaSelfController, keyof typeof toolNames>
type SelfToolResult = Awaited<ReturnType<ToolDefinition['execute']>>

const strictObject = { additionalProperties: false }
const noArgs = Type.Object({}, strictObject)
const query = Type.String({ minLength: 1, maxLength: 80 })
const uuid = Type.String({ pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' })
const reference = { generation: uuid, reference: uuid }

function textResult(value: unknown): SelfToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], details: {} }
}

export function buildPiPromaSelfTools(
  access: PromaSelfToolAccess | undefined,
  controller: SelfController = promaSelfController,
): ToolDefinition[] {
  if (!access || access.signal.aborted || !access.isCurrent()) return []
  const createTool = <T extends TSchema>(
    name: string,
    label: string,
    description: string,
    parameters: T,
    run: (execution: PromaSelfExecution, input: Static<T>) => Promise<SelfToolResult>,
  ): ToolDefinition => ({
    name, label, description, parameters,
    async execute(_id, input, signal) {
      const execution: PromaSelfExecution = {
        sessionId: access.sessionId,
        source: 'user',
        observationOwner: access,
        isCurrent: access.isCurrent,
        signal: signal ? AbortSignal.any([access.signal, signal]) : access.signal,
      }
      assertPromaSelfExecution(execution)
      if (!Check(parameters, input)) throw new Error('Proma 界面工具参数无效')
      const result = await run(execution, input)
      assertPromaSelfExecution(execution)
      return result
    },
  })
  const completed = () => textResult({ performed: true })
  return [
    createTool(toolNames.observe, '观察 Proma 界面', '列出 Proma 主窗口当前可操作的控件与短期引用。先阅读 proma-self-control Skill。',
      noArgs, async execution => textResult(await controller.observe(execution))),
    createTool(toolNames.find, '查找 Proma 控件', '按固定控件 ID 或显示标签查找 Proma 当前可操作的控件。',
      Type.Object({ query }, strictObject), async (execution, input) => textResult(await controller.find(execution, input.query))),
    createTool(toolNames.click, '点击 Proma 控件', '使用同次观察的 generation 和 reference 点击已授权的 Proma 导航控件。切换会话会结束当前界面操作授权。',
      Type.Object(reference, strictObject), async (execution, input) => {
        await controller.click(execution, input.generation, input.reference)
        return completed()
      }),
    createTool(toolNames.fill, '填写 Proma 文件搜索', '使用新鲜引用填写 Proma 的文件搜索框，限单行搜索词。',
      Type.Object({ ...reference, text: Type.String({ maxLength: 256 }) }, strictObject), async (execution, input) => {
        await controller.fill(execution, input.generation, input.reference, input.text)
        return completed()
      }),
    createTool(toolNames.press, '操作 Proma 文件搜索', '使用新鲜引用在文件搜索框按上键、下键或 Escape。',
      Type.Object({ ...reference, key: Type.Union(PROMA_SELF_SEARCH_KEYS.map(key => Type.Literal(key))) }, strictObject), async (execution, input) => {
        await controller.press(execution, input.generation, input.reference, input.key)
        return completed()
      }),
    createTool(toolNames.scroll, '滚动 Proma 文件区', '使用新鲜引用滚动当前授权的 Proma 文件列表。',
      Type.Object({ ...reference, deltaY: Type.Integer({ minimum: -1200, maximum: 1200 }) }, strictObject), async (execution, input) => {
        await controller.scroll(execution, input.generation, input.reference, input.deltaY)
        return completed()
      }),
    createTool(toolNames.waitFor, '等待 Proma 控件', '等待固定 ID 或标签对应的 Proma 控件，最多 10 秒。',
      Type.Object({ query, timeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: 10_000 })) }, strictObject),
      async (execution, input) => textResult(await controller.waitFor(execution, input.query, input.timeoutMs))),
    createTool(toolNames.screenshot, '截取 Proma 脱敏图', '将 Proma 已授权控件的脱敏 PNG 交付到当前会话。图中只有固定标签和控件轮廓。',
      noArgs, async execution => {
        const image = await controller.screenshot(execution)
        return {
          content: [
            { type: 'text', text: `已交付 Proma 脱敏截图（${image.width} × ${image.height}）` },
            { type: 'image', mimeType: image.mimeType, data: image.base64 },
          ],
          details: {},
        }
      }),
  ]
}
