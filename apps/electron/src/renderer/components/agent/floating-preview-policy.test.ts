import { describe, expect, test } from 'bun:test'
import { clampFloatingPreviewPosition, shouldShowFloatingPreview } from './floating-preview-policy'

describe('Agent 浮动预览', () => {
  test('本轮有活动时显示，打开完整界面或本轮隐藏后收起', () => {
    const current = { activityAt: 100, startedAt: 90, dismissed: false, fullViewOpen: false }
    expect(shouldShowFloatingPreview(current)).toBe(true)
    expect(shouldShowFloatingPreview({ ...current, fullViewOpen: true })).toBe(false)
    expect(shouldShowFloatingPreview({ ...current, dismissed: true })).toBe(false)
    expect(shouldShowFloatingPreview({ ...current, startedAt: 110 })).toBe(false)
    expect(shouldShowFloatingPreview({ ...current, startedAt: 110, activityAt: 120 })).toBe(true)
  })

  test('鼠标或键盘拖出边界时限制位置，窗口缩小时仍保留操作入口', () => {
    expect(clampFloatingPreviewPosition({ x: -20, y: 500 }, { x: 300, y: 120 })).toEqual({ x: 0, y: 120 })
    expect(clampFloatingPreviewPosition({ x: 45, y: 27 }, { x: 300, y: 120 })).toEqual({ x: 45, y: 27 })
    expect(clampFloatingPreviewPosition({ x: 4, y: 4 }, { x: -3, y: -1 })).toEqual({ x: 0, y: 0 })
  })
})
