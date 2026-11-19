import { describe, expect, test } from 'bun:test'
import {
  PROVIDER_DEFAULT_URLS,
  getQwenModelCapability,
  getQwenModelPresets,
  inferContextWindow,
  inferReasoningTransport,
  normalizeQwenModelId,
  resolveReasoningProfile,
  type Channel,
} from '@proma/shared'
import {
  LEGACY_QWEN_TOKEN_PLAN_ANTHROPIC_URL,
  getQwenNativeTotal,
  migrateQwenTokenPlanChannel,
  parseQwenNativeModelsResponse,
  parseQwenTokenPlanModelsResponse,
  resolveQwenNativeModelsUrl,
} from './qwen-models'

function createTokenPlanChannel(overrides?: Partial<Channel>): Channel {
  return {
    id: 'ch-qwen-tp',
    name: 'Qwen Token Plan',
    provider: 'qwen-token-plan',
    baseUrl: LEGACY_QWEN_TOKEN_PLAN_ANTHROPIC_URL,
    apiKey: 'encrypted-key',
    models: [
      { id: 'qwen3.8-max-preview', name: 'Qwen3.8 Max Preview', enabled: true },
      { id: 'qwen4-max', name: 'Qwen4 Max', enabled: true },
    ],
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

describe('Qwen 4 & Token Plan OpenAI 兼容迁移', () => {
  test('Given 旧版 qwen-token-plan 渠道配置 When 执行迁移 Then 自动切换为 OpenAI 默认地址、映射预览模型并去重保持幂等', () => {
    const legacy = createTokenPlanChannel({
      models: [
        { id: 'qwen3.8-max-preview', name: 'Qwen3.8 Max Preview', enabled: true },
        { id: 'qwen3.8-max', name: 'Qwen3.8 Max', enabled: false },
      ],
    })

    const migrated = migrateQwenTokenPlanChannel(legacy)
    expect(migrated.baseUrl).toBe(PROVIDER_DEFAULT_URLS['qwen-token-plan'])
    expect(migrated.models).toEqual([
      { id: 'qwen3.8-max', name: 'Qwen3.8 Max', enabled: true },
    ])

    // 幂等性：再次迁移返回原引用
    expect(migrateQwenTokenPlanChannel(migrated)).toBe(migrated)

    // 自定义代理地址保留不变，仅清理预览模型 ID
    const customProxy = createTokenPlanChannel({
      baseUrl: 'https://proxy.example.com/custom-qwen/v1',
      models: [{ id: 'qwen4-max', name: 'Qwen4 Max', enabled: true }],
    })
    expect(migrateQwenTokenPlanChannel(customProxy)).toBe(customProxy)

    // 其他 provider 不受影响
    const anthropic = createTokenPlanChannel({ provider: 'anthropic' })
    expect(migrateQwenTokenPlanChannel(anthropic)).toBe(anthropic)
  })

  test('Given Token Plan OpenAI /v1/models 响应 When 解析模型目录 Then 规范化 [1m] 后缀并按 Qwen + 兼容清单过滤排序', () => {
    const models = parseQwenTokenPlanModelsResponse({
      data: [
        { id: 'glm-5.3' },
        { id: 'qwen4-max-preview[1m]' },
        { id: 'qwen4-max' },
        { id: 'unknown-internal-model' },
        { id: 'deepseek-v4.1-flash' },
      ],
    })

    expect(models.map((m) => ({ id: m.id, source: m.source }))).toEqual([
      { id: 'qwen4-max', source: 'fetched' },
      { id: 'qwen4-max-preview', source: 'fetched' },
      { id: 'deepseek-v4.1-flash', source: 'fetched' },
      { id: 'glm-5.3', source: 'fetched' },
    ])

    expect(() => parseQwenTokenPlanModelsResponse({ data: 'invalid' })).toThrow('Token Plan 模型列表格式无效')
    expect(() => parseQwenTokenPlanModelsResponse({ data: [{ id: '' }] })).toThrow('Token Plan 模型列表格式无效')
  })

  test('Given DashScope 按量 /api/v1/models 响应 When 解析与构造 URL Then 保留最新模型自定义名称且校验结构', () => {
    expect(resolveQwenNativeModelsUrl('https://dashscope.aliyuncs.com/compatible-mode/v1/')).toBe(
      'https://dashscope.aliyuncs.com/api/v1/models',
    )

    const payload = {
      output: {
        total: 3,
        models: [
          { model: 'qwen4-max', name: '通义千问 4 Max' },
          { model: 'qwen3.8-flash[1m]', name: 'Qwen 3.8 Flash Live' },
          { model: 'qwen-plus', name: 'Legacy Qwen Plus' },
        ],
      },
    }

    expect(getQwenNativeTotal(payload)).toBe(3)
    expect(getQwenNativeTotal({ output: { total: -1 } })).toBeUndefined()

    const parsed = parseQwenNativeModelsResponse(payload)
    expect(parsed).toEqual([
      { id: 'qwen4-max', name: '通义千问 4 Max', enabled: true, source: 'fetched' },
      { id: 'qwen3.8-flash', name: 'Qwen 3.8 Flash Live', enabled: true, source: 'fetched' },
    ])

    expect(() => parseQwenNativeModelsResponse({})).toThrow('按量 API 模型列表格式无效')
    expect(() => parseQwenNativeModelsResponse({ output: { models: [{ model: '  ' }] } })).toThrow('按量 API 模型列表格式无效')
  })

  test('Given Qwen 4 与 3.8 模型 ID When 查询能力、预设、上下文窗口与推理档位 Then 符合正式版契约', () => {
    expect(normalizeQwenModelId('  Qwen4-Max-Preview[1M] ')).toBe('qwen4-max-preview')
    expect(getQwenModelCapability('qwen4-max')).toEqual({ contextWindow: 1_000_000, maxTokens: 262_144 })
    expect(getQwenModelCapability('qwen4-max-preview[1m]')).toEqual({ contextWindow: 1_000_000, maxTokens: 393_216 })
    expect(getQwenModelCapability('qwen3.8-max')).toEqual({ contextWindow: 1_000_000, maxTokens: 131_072 })
    expect(getQwenModelCapability('qwen-plus')).toBeUndefined()

    expect(getQwenModelPresets('qwen-token-plan').map((m) => m.id)).toEqual([
      'qwen4-max',
      'qwen4-max-preview',
      'qwen3.8-max',
      'qwen3.8-flash',
    ])
    expect(getQwenModelPresets('qwen').map((m) => m.id)).toEqual([
      'qwen4-max',
      'qwen3.8-max',
      'qwen3.8-flash',
    ])

    expect(inferContextWindow('qwen4-plus')).toBe(1_000_000)

    const tokenPlanTransport = inferReasoningTransport('qwen-token-plan')
    expect(tokenPlanTransport).toBe('openai-completions')
    expect(inferReasoningTransport('qwen')).toBe('openai-completions')

    expect(resolveReasoningProfile({
      modelId: 'qwen4-max',
      transport: tokenPlanTransport,
    })?.id).toBe('qwen4-max')
    expect(resolveReasoningProfile({
      modelId: 'qwen4-max-preview',
      transport: tokenPlanTransport,
    })?.id).toBe('qwen4-max-preview')
    expect(resolveReasoningProfile({
      modelId: 'qwen3.8-flash',
      transport: tokenPlanTransport,
    })?.id).toBe('qwen3.8')
  })
})
