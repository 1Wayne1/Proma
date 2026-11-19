import { describe, expect, test } from 'bun:test'
import { PROVIDER_DEFAULT_URLS, type ProviderType } from '@proma/shared'
import { AnthropicAdapter } from './anthropic-adapter.ts'
import { getAdapter } from './index.ts'
import { setPromaVersion } from './user-agent.ts'

function buildRequest(provider: ProviderType, apiKey = 'test-key') {
  const adapter = new AnthropicAdapter(provider)
  const baseUrl = provider === 'xiaomi-token-plan'
    ? 'https://token-plan-cn.xiaomimimo.com/anthropic'
    : provider === 'zhipu-coding-team'
      ? 'https://open.bigmodel.cn/api/anthropic'
      : 'https://api.xiaomimimo.com/anthropic'

  return adapter.buildStreamRequest({
    baseUrl,
    apiKey,
    modelId: 'mimo-v2.6-pro',
    history: [],
    userMessage: 'ping',
    readImageAttachments: () => [],
  })
}

describe('AnthropicAdapter headers', () => {
  test('xiaomi API uses api-key authentication', () => {
    const request = buildRequest('xiaomi')

    expect(request.headers['api-key']).toBe('test-key')
    expect(request.headers.Authorization).toBeUndefined()
    expect(request.headers['User-Agent']).toBeUndefined()
  })

  test('xiaomi token plan keeps bearer authentication with Proma User-Agent', () => {
    setPromaVersion('9.9.9')

    const request = buildRequest('xiaomi-token-plan')

    expect(request.headers.Authorization).toBe('Bearer test-key')
    expect(request.headers['User-Agent']).toBe('Proma/9.9.9 (+https://github.com/ErlichLiu/Proma)')
    expect(request.headers['api-key']).toBeUndefined()
  })

  test('qwen token plan routes via OpenAI-compatible adapter with bearer authentication', () => {
    const adapter = getAdapter('qwen-token-plan')
    const request = adapter.buildStreamRequest({
      baseUrl: PROVIDER_DEFAULT_URLS['qwen-token-plan'],
      apiKey: 'test-key',
      modelId: 'qwen4-max',
      history: [],
      userMessage: 'ping',
      readImageAttachments: () => [],
    })

    expect(request.url).toBe('https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/chat/completions')
    expect(request.headers.Authorization).toBe('Bearer test-key')
    expect(request.headers['anthropic-version']).toBeUndefined()
  })

  test('zhipu team plan uses apiKey from JSON for model calls', () => {
    setPromaVersion('9.9.9')

    const request = buildRequest(
      'zhipu-coding-team',
      '{"apiKey":"model-key","organization":"org","project":"proj"}',
    )

    expect(request.headers.Authorization).toBe('Bearer model-key')
    expect(request.headers['User-Agent']).toBe('Proma/9.9.9 (+https://github.com/ErlichLiu/Proma)')
    expect(request.headers['api-key']).toBeUndefined()
  })
})
