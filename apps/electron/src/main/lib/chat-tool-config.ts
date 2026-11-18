/**
 * Chat 工具配置服务
 *
 * 管理 ~/.proma/chat-tools.json 的读写。
 * 管理 Agent 模式推荐和自定义 HTTP 工具。旧凭据字段仅透传保留，不再执行旧搜索或生图能力。
 */

import { readFileSync, existsSync } from 'node:fs'
import { getChatToolsConfigPath } from './config-paths'
import { writeJsonFileAtomic } from './safe-file'
import type { ChatToolsFileConfig, ChatToolState, ChatToolMeta } from '@proma/shared'

/** 默认配置 */
const DEFAULT_CONFIG: ChatToolsFileConfig = {
  toolStates: {
    memory: { enabled: true },
    'agent-mode-recommend': { enabled: true },
  },
  toolCredentials: {},
  customTools: [],
}

/**
 * 读取工具配置
 */
function readConfig(forWrite: boolean): ChatToolsFileConfig {
  const filePath = getChatToolsConfigPath()

  if (!existsSync(filePath)) {
    return structuredClone(DEFAULT_CONFIG)
  }

  try {
    const raw = readFileSync(filePath, 'utf-8')
    const data = JSON.parse(raw.replace(/^\uFEFF/, '')) as Partial<ChatToolsFileConfig>
    const isMap = (value: unknown) => typeof value === 'object' && value !== null && !Array.isArray(value)
    if (!isMap(data) || (data.toolStates != null && !isMap(data.toolStates)) ||
        (data.toolCredentials != null && !isMap(data.toolCredentials)) ||
        (data.customTools != null && (!Array.isArray(data.customTools) || data.customTools.some(tool => !isMap(tool) || typeof tool.id !== 'string')))) {
      throw new Error('配置结构无效')
    }
    return {
      ...data,
      toolStates: { ...DEFAULT_CONFIG.toolStates, ...data.toolStates },
      toolCredentials: data.toolCredentials ?? {},
      customTools: data.customTools ?? [],
    }
  } catch {
    if (forWrite) throw new Error('Chat 工具配置无法解析，已保留原文件')
    console.error('[Chat 工具配置] 读取失败')
    return structuredClone(DEFAULT_CONFIG)
  }
}

export function getChatToolsConfig(): ChatToolsFileConfig {
  return readConfig(false)
}

/**
 * 保存工具配置
 */
function saveChatToolsConfig(config: ChatToolsFileConfig): void {
  const filePath = getChatToolsConfigPath()
  try {
    writeJsonFileAtomic(filePath, config)
    console.log('[Chat 工具配置] 已保存')
  } catch (error) {
    console.error('[Chat 工具配置] 保存失败:', error)
    throw new Error('保存 Chat 工具配置失败')
  }
}

/**
 * 更新单个工具的开关状态
 */
export function updateToolState(toolId: string, state: ChatToolState): void {
  const config = readConfig(true)
  config.toolStates[toolId] = { ...config.toolStates[toolId], ...state }
  saveChatToolsConfig(config)
}

/**
 * 添加自定义工具
 */
export function addCustomTool(meta: ChatToolMeta): void {
  const config = readConfig(true)
  const index = config.customTools.findIndex(tool => tool.id === meta.id)
  if (index === -1) config.customTools.push(meta)
  else {
    // 保留扩展字段。可选的已知字段仍允许编辑者清空。
    config.customTools[index] = { ...config.customTools[index], icon: undefined, systemPromptAppend: undefined,
      httpConfig: undefined, ...meta }
  }
  config.toolStates[meta.id] ??= { enabled: false }
  saveChatToolsConfig(config)
}

/**
 * 删除自定义工具
 */
export function deleteCustomTool(toolId: string): void {
  const config = readConfig(true)
  config.customTools = config.customTools.filter((t) => t.id !== toolId)
  delete config.toolStates[toolId]
  delete config.toolCredentials[toolId]
  saveChatToolsConfig(config)
}
