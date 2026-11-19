import { describe, expect, test } from 'bun:test'
import {
  injectCodexFastMode,
  injectCodexSpeed,
  withCodexFastModeServiceTier,
  withCodexSpeedServiceTier,
} from './pi-codex-request-settings'
import { injectOpenAIReasoningLevel } from './pi-openai-reasoning-request-settings'
import { getCodexCatalogModels, requiresPromaUserAgent, resolvePiApi } from './pi-model-registry'
import { supportsPiDeveloperRole } from './pi-provider-compat'
import {
  getCodexSpeeds,
  inferCodexAlignedGPT5ContextWindow,
  isGpt61SolFamily,
  isGpt62ReasoningModel,
  resolveCodexSpeed,
  resolveReasoningProfile,
} from '@proma/shared'

describe('Pi Codex request settings', () => {
  test('Given 新旧速度字段与不同模型 When 组装请求 Then 新字段优先且极速仅发送给支持的模型', () => {
    const standard = { model: 'gpt-6-sol' }
    expect(resolveCodexSpeed({ codexFastMode: true }, standard.model)).toBe('fast')
    expect(resolveCodexSpeed({ codexFastMode: true, codexSpeed: 'standard' }, standard.model)).toBe('standard')
    expect(resolveCodexSpeed({ codexSpeed: 'ultrafast' }, standard.model)).toBe('standard')
    expect(injectCodexSpeed(standard, 'ultrafast')).toBe(standard)
    expect(getCodexSpeeds('gpt-6.1-sol-1')).toEqual(['standard', 'fast', 'ultrafast'])
    expect(injectCodexSpeed({ model: 'gpt-6-astra' }, 'ultrafast')).toEqual({ model: 'gpt-6-astra', service_tier: 'ultrafast' })
    expect(withCodexSpeedServiceTier({ transport: 'websocket' }, 'ultrafast')).toEqual({ transport: 'websocket', serviceTier: 'ultrafast' })
  })
  test('Given OpenAI model IDs When resolving profiles Then separates standard, max, and non-reasoning models', () => {
    expect(resolveReasoningProfile({ modelId: 'gpt-5.5', transport: 'openai-responses' })?.id).toBe('openai-reasoning-standard')
    expect(resolveReasoningProfile({ modelId: 'gpt-5.6-terra', transport: 'openai-responses' })?.id).toBe('openai-reasoning-max')
    expect(resolveReasoningProfile({ modelId: 'gpt-4o', transport: 'openai-responses' })).toBeUndefined()
    expect(resolveReasoningProfile({ modelId: 'gpt-5-chat-latest', transport: 'openai-responses' })).toBeUndefined()
  })

  test.each(['gpt-5.4', 'gpt-5.5', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'])(
    'Given supported %s When injecting Then requests priority tier',
    (model) => {
      expect(injectCodexFastMode({ model })).toEqual({ model, service_tier: 'priority' })
    },
  )

  test('Given unsupported model When injecting Then leaves payload unchanged', () => {
    const payload = { model: 'gpt-5.4-mini' }
    expect(injectCodexFastMode(payload)).toBe(payload)
  })

  test('Given existing service tier When injecting Then Fast Mode overrides it', () => {
    expect(injectCodexFastMode({ model: 'gpt-5.6-terra', service_tier: 'flex' })).toEqual({
      model: 'gpt-5.6-terra',
      service_tier: 'priority',
    })
  })

  test('Given provider stream options When applying Fast Mode Then preserves priority tier for cost accounting', () => {
    expect(withCodexFastModeServiceTier({ transport: 'websocket' })).toEqual({
      transport: 'websocket',
      serviceTier: 'priority',
    })
  })

  test('Given thinking is disabled When injecting Then explicitly sends none', () => {
    expect(injectOpenAIReasoningLevel({ model: 'gpt-5.5' }, { thinkingLevel: 'off' })).toEqual({
      model: 'gpt-5.5',
      reasoning: { effort: 'none' },
    })
  })

  test('Given direct Codex provider stream When injecting Then fills the selected non-off effort', () => {
    expect(injectOpenAIReasoningLevel({ model: 'gpt-5.5' }, { thinkingLevel: 'high' })).toEqual({
      model: 'gpt-5.5',
      reasoning: { effort: 'high' },
    })
  })

  test('Given GPT-5.6 max thinking When injecting Then preserves max effort', () => {
    expect(injectOpenAIReasoningLevel({ model: 'gpt-5.6-terra' }, { thinkingLevel: 'max' })).toEqual({
      model: 'gpt-5.6-terra',
      reasoning: { effort: 'max' },
    })
  })

  test('Given an upstream reasoning mode When injecting Then strips mode from the request', () => {
    expect(injectOpenAIReasoningLevel({
      model: 'gpt-5.6',
      reasoning: { effort: 'high', mode: 'pro', summary: 'auto' },
    }, { thinkingLevel: 'high' })).toEqual({
      model: 'gpt-5.6',
      reasoning: { effort: 'high', summary: 'auto' },
    })
  })

  test('Given non-object payload When injecting Then leaves payload unchanged', () => {
    expect(injectCodexFastMode('not-a-request')).toBe('not-a-request')
  })

  test('Given GPT-6.2 Sol 与 Astra 模型 When 解析推理档位、速度与上下文窗口 Then 各自匹配正式规格', async () => {
    expect(isGpt62ReasoningModel('gpt-6.2-sol')).toBe(true)
    expect(isGpt62ReasoningModel('gpt-6.2-astra')).toBe(true)
    expect(isGpt61SolFamily('gpt-6.1-sol')).toBe(true)
    expect(isGpt61SolFamily('gpt-6.2-sol')).toBe(false)

    expect(resolveReasoningProfile({ modelId: 'gpt-6.2-sol', transport: 'openai-responses' })?.id).toBe('openai-reasoning-6.2')
    expect(resolveReasoningProfile({ modelId: 'gpt-6.2-astra', transport: 'openai-responses' })?.id).toBe('openai-reasoning-6.2')

    expect(getCodexSpeeds('gpt-6.2-sol')).toEqual(['standard', 'fast', 'ultrafast'])
    expect(getCodexSpeeds('gpt-6.2-astra')).toEqual(['standard', 'fast'])
    expect(injectCodexSpeed({ model: 'gpt-6.2-sol' }, 'ultrafast')).toEqual({
      model: 'gpt-6.2-sol',
      service_tier: 'ultrafast',
    })
    const astraPayload = { model: 'gpt-6.2-astra' }
    expect(injectCodexSpeed(astraPayload, 'ultrafast')).toBe(astraPayload)

    expect(inferCodexAlignedGPT5ContextWindow('gpt-6.2-sol')).toBe(500_000)
    expect(inferCodexAlignedGPT5ContextWindow('gpt-6.2-astra')).toBe(372_000)

    const catalog = await getCodexCatalogModels()
    expect(catalog.find((m) => m.id === 'gpt-6.2-sol')).toMatchObject({
      id: 'gpt-6.2-sol',
      contextWindow: 500_000,
    })
    expect(catalog.find((m) => m.id === 'gpt-6.2-astra')).toMatchObject({
      id: 'gpt-6.2-astra',
      contextWindow: 372_000,
    })
  })

  test('Given Qwen 与 Token Plan 渠道 When 解析 Pi 协议与请求兼容性 Then 统一走 openai-completions 且降级 system 角色', () => {
    expect(resolvePiApi('qwen')).toBe('openai-completions')
    expect(resolvePiApi('qwen-token-plan')).toBe('openai-completions')
    expect(supportsPiDeveloperRole('qwen')).toBe(false)
    expect(supportsPiDeveloperRole('qwen-token-plan')).toBe(false)
    expect(supportsPiDeveloperRole('openai')).toBe(true)
    expect(requiresPromaUserAgent('qwen-token-plan')).toBe(false)
  })
})
