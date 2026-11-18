import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { getCodexSpeeds } from '@proma/shared'
import type { CodexSpeed } from '@proma/shared'

type ProviderPayload = Record<string, unknown>

export const CODEX_FAST_MODE_SERVICE_TIER = 'priority'
const CODEX_SPEED_TIERS = { fast: CODEX_FAST_MODE_SERVICE_TIER, ultrafast: 'ultrafast' } as const

export interface CodexFastModeSettings {
  fastMode?: boolean
}

function isProviderPayload(payload: unknown): payload is ProviderPayload {
  return typeof payload === 'object' && payload !== null && !Array.isArray(payload)
}

/** 为符合条件的 Codex Responses 请求附加 OpenAI priority service tier。 */
export function injectCodexFastMode(payload: unknown): unknown {
  return injectCodexSpeed(payload, 'fast')
}

export function injectCodexSpeed(payload: unknown, speed: CodexSpeed): unknown {
  if (!isProviderPayload(payload)) return payload
  const modelId = typeof payload.model === 'string' ? payload.model : undefined
  if (speed === 'standard' || !getCodexSpeeds(modelId).includes(speed)) return payload
  return { ...payload, service_tier: CODEX_SPEED_TIERS[speed] }
}

/** Pi Agent 内部 stream function 使用的 provider 专属 service tier。 */
export function withCodexFastModeServiceTier<T extends object | undefined>(options: T): T & { serviceTier: typeof CODEX_FAST_MODE_SERVICE_TIER } {
  return withCodexSpeedServiceTier(options, 'fast')
}

export function withCodexSpeedServiceTier<T extends object | undefined, S extends keyof typeof CODEX_SPEED_TIERS>(options: T, speed: S): T & { serviceTier: typeof CODEX_SPEED_TIERS[S] } {
  return { ...options, serviceTier: CODEX_SPEED_TIERS[speed] }
}

/** Pi inline extension for Codex priority service tier. */
export function createCodexFastModeExtension(settings: CodexFastModeSettings): (pi: ExtensionAPI) => void {
  return createCodexSpeedExtension(settings.fastMode ? 'fast' : 'standard')
}

export function createCodexSpeedExtension(speed: CodexSpeed): (pi: ExtensionAPI) => void {
  return (pi) => {
    pi.on('before_provider_request', (event) => {
      const updatedPayload = injectCodexSpeed(event.payload, speed)
      return updatedPayload === event.payload ? undefined : updatedPayload
    })
  }
}
