import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import * as os from 'node:os'
import { join } from 'node:path'
import { serializeCodexCredentials } from '@proma/shared'

type ChannelManagerModule = typeof import('./channel-manager')

let channelManager: ChannelManagerModule
let tempHome: string
let encryptionAvailable = false
const originalHome = process.env.HOME
const originalPromaDev = process.env.PROMA_DEV

mock.module('electron', () => ({
  app: {
    isPackaged: true,
    getPath: () => join(process.env.HOME ?? tempHome, 'Library', 'Application Support'),
  },
  safeStorage: {
    isEncryptionAvailable: () => encryptionAvailable,
    encryptString: (value: string) => Buffer.from(`cipher:${value}`),
    decryptString: (value: Buffer) => {
      const encoded = value.toString('utf8')
      if (!encoded.startsWith('cipher:')) throw new Error('密钥不可解密')
      return encoded.slice('cipher:'.length)
    },
  },
  shell: {
    openExternal: async () => undefined,
  },
}))

mock.module('node:os', () => ({
  ...os,
  homedir: () => tempHome,
}))

function writeChannels(channels: unknown[]): void {
  const configDir = join(tempHome, '.proma')
  mkdirSync(configDir, { recursive: true })
  writeFileSync(
    join(configDir, 'channels.json'),
    JSON.stringify({ version: 2, channels }),
    'utf-8',
  )
}

beforeAll(async () => {
  tempHome = mkdtempSync(join(os.tmpdir(), 'proma-channel-runtime-key-'))
  process.env.HOME = tempHome
  process.env.PROMA_DEV = '0'
  channelManager = await import('./channel-manager')
})

beforeEach(() => {
  encryptionAvailable = false
  rmSync(join(tempHome, '.proma'), { recursive: true, force: true })
})

afterAll(() => {
  if (originalHome === undefined) {
    delete process.env.HOME
  } else {
    process.env.HOME = originalHome
  }
  if (originalPromaDev === undefined) {
    delete process.env.PROMA_DEV
  } else {
    process.env.PROMA_DEV = originalPromaDev
  }
  rmSync(tempHome, { recursive: true, force: true })
})

describe('渠道运行时认证解析', () => {
  test('Given 旧版在系统加密不可用时保存了明文 When 重启后加密可用 Then 恢复原始渠道凭据', async () => {
    writeChannels([{ id: 'legacy', name: '验收渠道', provider: 'openai-responses', baseUrl: 'https://api.example.com/v1',
      apiKey: 'legacy-key-with-dashes', models: [], enabled: true, createdAt: 1, updatedAt: 1 }])
    encryptionAvailable = true
    await expect(channelManager.resolveChannelRuntimeApiKey('legacy')).resolves.toBe('legacy-key-with-dashes')
  })

  test('Given 无系统加密时保存可作 Base64 的密钥 When 加密可用 Then 通过存储标记恢复原值', async () => {
    const input = { name: '验收渠道', provider: 'openai-responses' as const, baseUrl: 'https://api.example.com/v1',
      apiKey: 'YWJjZA==', models: [], enabled: true }
    const channel = channelManager.createChannel(input)
    encryptionAvailable = true
    await expect(channelManager.resolveChannelRuntimeApiKey(channel.id)).resolves.toBe(input.apiKey)

    const encryptedChannel = channelManager.createChannel(input)
    await expect(channelManager.resolveChannelRuntimeApiKey(encryptedChannel.id)).resolves.toBe(input.apiKey)
  })

  test('Given 系统加密可用但密文解密失败 When 解析凭据 Then 保留错误而不将密文作为密钥发送', async () => {
    writeChannels([{ id: 'bad', name: '验收渠道', provider: 'openai-responses', baseUrl: 'https://api.example.com/v1',
      apiKey: Buffer.from('other-keychain').toString('base64'), models: [], enabled: true, createdAt: 1, updatedAt: 1 }])
    encryptionAvailable = true
    await expect(channelManager.resolveChannelRuntimeApiKey('bad')).rejects.toThrow('解密 API Key 失败')
  })

  test('Given ChatGPT OAuth 渠道 When 解析运行时 key Then 返回 access token 而不是凭据 JSON', async () => {
    writeChannels([
      {
        id: 'codex-channel',
        name: 'ChatGPT',
        provider: 'openai-codex',
        baseUrl: '',
        apiKey: serializeCodexCredentials({
          access: 'oauth-access-token',
          refresh: 'oauth-refresh-token',
          expires: Date.now() + 3_600_000,
        }),
        models: [],
        enabled: true,
        createdAt: 1,
        updatedAt: 1,
      },
    ])

    await expect(channelManager.resolveChannelRuntimeApiKey('codex-channel'))
      .resolves.toBe('oauth-access-token')
  })

  test('Given 普通渠道 When 解析运行时 key Then 返回解密后的 API Key', async () => {
    writeChannels([
      {
        id: 'api-key-channel',
        name: 'Anthropic',
        provider: 'anthropic',
        baseUrl: 'https://api.anthropic.com',
        apiKey: 'plain-api-key',
        models: [],
        enabled: true,
        createdAt: 1,
        updatedAt: 1,
      },
    ])

    await expect(channelManager.resolveChannelRuntimeApiKey('api-key-channel'))
      .resolves.toBe('plain-api-key')
  })
})
