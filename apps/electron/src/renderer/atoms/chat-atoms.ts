/**
 * 跨视图复用的渠道与模型选择器基础状态
 */

import { atom } from 'jotai'
import type { Channel } from '@proma/shared'

/** 全局渠道列表缓存（启动时加载一次，设置变更时刷新） */
export const channelsAtom = atom<Channel[]>([])

/** 渠道列表是否已完成首次加载 */
export const channelsLoadedAtom = atom(false)

/** 主输入框「模型选择器」是否打开（错误卡片的「重新选择模型」按钮会置 true） */
export const modelSelectorOpenAtom = atom(false)

/** 选中的模型信息 */
export interface SelectedModel {
  channelId: string
  modelId: string
}
