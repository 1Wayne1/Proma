/**
 * 通义千问 Qwen 4 / 3.8 最新模型能力与预设清单
 */

import type { ChannelModel } from '../types/channel'

export interface QwenModelCapability {
  contextWindow: number
  maxTokens: number
}

const QWEN_MODEL_CAPABILITIES = {
  'qwen4-max': { contextWindow: 1_000_000, maxTokens: 262_144 },
  // 限时预览：2026-11-25 24:00（UTC+8）下线；实时目录会在下线后自然移除。
  'qwen4-max-preview': { contextWindow: 1_000_000, maxTokens: 393_216 },
  'qwen3.8-max': { contextWindow: 1_000_000, maxTokens: 131_072 },
  'qwen3.8-flash': { contextWindow: 1_000_000, maxTokens: 131_072 },
} as const satisfies Record<string, QwenModelCapability>

export type QwenLatestModelId = keyof typeof QWEN_MODEL_CAPABILITIES

const QWEN_MODEL_NAMES: Record<QwenLatestModelId, string> = {
  'qwen4-max': 'Qwen4 Max',
  'qwen4-max-preview': 'Qwen4 Max Preview',
  'qwen3.8-max': 'Qwen3.8 Max',
  'qwen3.8-flash': 'Qwen3.8 Flash',
}

export function normalizeQwenModelId(modelId: string | undefined): string {
  return modelId?.trim().toLowerCase().replace(/\[1m\]$/i, '') ?? ''
}

export function isQwenLatestModel(modelId: string | undefined): modelId is QwenLatestModelId {
  return Object.hasOwn(QWEN_MODEL_CAPABILITIES, normalizeQwenModelId(modelId))
}

export function getQwenModelCapability(modelId: string | undefined): QwenModelCapability | undefined {
  const normalized = normalizeQwenModelId(modelId)
  if (!isQwenLatestModel(normalized)) return undefined
  return { ...QWEN_MODEL_CAPABILITIES[normalized] }
}

export function getQwenModelDisplayName(modelId: QwenLatestModelId): string {
  return QWEN_MODEL_NAMES[modelId]
}

export function getQwenModelPresets(provider: 'qwen' | 'qwen-token-plan'): ChannelModel[] {
  const ids: readonly QwenLatestModelId[] = provider === 'qwen-token-plan'
    ? ['qwen4-max', 'qwen4-max-preview', 'qwen3.8-max', 'qwen3.8-flash']
    : ['qwen4-max', 'qwen3.8-max', 'qwen3.8-flash']
  return ids.map((id) => ({
    id,
    name: getQwenModelDisplayName(id),
    enabled: true,
  }))
}
