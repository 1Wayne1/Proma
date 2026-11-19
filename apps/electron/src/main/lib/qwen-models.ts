/**
 * 通义千问（按量 API & Token Plan）模型目录与配置迁移辅助
 */

import {
  PROVIDER_DEFAULT_URLS,
  getQwenModelPresets,
  isQwenLatestModel,
  normalizeQwenModelId,
  type Channel,
  type ChannelModel,
} from '@proma/shared'

export const LEGACY_QWEN_TOKEN_PLAN_ANTHROPIC_URL =
  'https://token-plan.cn-beijing.maas.aliyuncs.com/apps/anthropic/v1/messages'

const TOKEN_PLAN_COMPATIBLE_MODEL_PRESETS: readonly ChannelModel[] = [
  { id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash', enabled: true },
  { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', enabled: true },
  { id: 'glm-5.3', name: 'GLM-5.3', enabled: true },
  { id: 'glm-5.2', name: 'GLM-5.2', enabled: true },
]

export function getQwenTokenPlanCompatibleModelPresets(): ChannelModel[] {
  return TOKEN_PLAN_COMPATIBLE_MODEL_PRESETS.map((model) => ({ ...model }))
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function shouldMigrateLegacyTokenPlanUrl(baseUrl: string): boolean {
  const normalizeUrl = (value: string): string => value.trim().replace(/\/+$/, '')
  try {
    const parsed = new URL(baseUrl.trim())
    return parsed.origin === new URL(LEGACY_QWEN_TOKEN_PLAN_ANTHROPIC_URL).origin
      && (parsed.pathname === '/apps/anthropic' || parsed.pathname.startsWith('/apps/anthropic/'))
  } catch {
    return normalizeUrl(baseUrl) === normalizeUrl(LEGACY_QWEN_TOKEN_PLAN_ANTHROPIC_URL)
  }
}

/**
 * 将旧版 qwen-token-plan Anthropic 兼容地址及预览模型 ID 迁移至 OpenAI 兼容协议与正式 ID。
 * 自定义代理地址保留不变。
 */
export function migrateQwenTokenPlanChannel(channel: Channel): Channel {
  if (channel.provider !== 'qwen-token-plan') return channel

  const shouldMigrateUrl = shouldMigrateLegacyTokenPlanUrl(channel.baseUrl)
  const migratedModels = channel.models.map((model) =>
    model.id === 'qwen3.8-max-preview'
      ? { ...model, id: 'qwen3.8-max', name: 'Qwen3.8 Max' }
      : model,
  )
  const models = migratedModels.filter((model, index) =>
    migratedModels.findIndex((candidate) => candidate.id === model.id) === index,
  )
  const modelsChanged = models.length !== channel.models.length
    || models.some((model, index) => model !== channel.models[index])

  if (!shouldMigrateUrl && !modelsChanged) return channel
  return {
    ...channel,
    ...(shouldMigrateUrl ? { baseUrl: PROVIDER_DEFAULT_URLS['qwen-token-plan'] } : {}),
    ...(modelsChanged ? { models } : {}),
  }
}

interface ParsedQwenEntry {
  id: string
  name?: string
}

function curatedModels(provider: 'qwen' | 'qwen-token-plan', entries: readonly ParsedQwenEntry[]): ChannelModel[] {
  const byId = new Map(entries.map((entry) => [entry.id, entry]))
  const presets = provider === 'qwen-token-plan'
    ? [...getQwenModelPresets(provider), ...getQwenTokenPlanCompatibleModelPresets()]
    : getQwenModelPresets(provider)

  return presets.flatMap((preset) => {
    const entry = byId.get(preset.id)
    if (!entry) return []
    return [{ ...preset, name: entry.name || preset.name, source: 'fetched' as const }]
  })
}

export function parseQwenTokenPlanModelsResponse(payload: unknown): ChannelModel[] {
  const data = asRecord(payload)?.data
  if (!Array.isArray(data)) throw new Error('Token Plan 模型列表格式无效')
  const entries: ParsedQwenEntry[] = data.map((value) => {
    const item = asRecord(value)
    if (typeof item?.id !== 'string' || !item.id.trim()) {
      throw new Error('Token Plan 模型列表格式无效')
    }
    return { id: normalizeQwenModelId(item.id) }
  })
  return curatedModels('qwen-token-plan', entries)
}

export function parseQwenNativeModelsResponse(payload: unknown): ChannelModel[] {
  const output = asRecord(asRecord(payload)?.output)
  const models = output?.models
  if (!Array.isArray(models)) throw new Error('按量 API 模型列表格式无效')
  const entries: ParsedQwenEntry[] = models.map((value) => {
    const item = asRecord(value)
    if (typeof item?.model !== 'string' || !item.model.trim()) {
      throw new Error('按量 API 模型列表格式无效')
    }
    const id = normalizeQwenModelId(item.model)
    return {
      id,
      ...(isQwenLatestModel(id) && typeof item.name === 'string' && item.name.trim()
        ? { name: item.name.trim() }
        : {}),
    }
  })
  return curatedModels('qwen', entries)
}

export function resolveQwenNativeModelsUrl(baseUrl: string): string {
  return `${new URL(baseUrl.trim()).origin}/api/v1/models`
}

export function getQwenNativeTotal(payload: unknown): number | undefined {
  const total = asRecord(asRecord(payload)?.output)?.total
  return typeof total === 'number' && Number.isSafeInteger(total) && total >= 0 ? total : undefined
}
