interface PreviewVisibility {
  activityAt: number
  startedAt: number
  dismissed: boolean
  fullViewOpen: boolean
}

export function shouldShowFloatingPreview({ activityAt, startedAt, dismissed, fullViewOpen }: PreviewVisibility): boolean {
  return activityAt >= startedAt && !dismissed && !fullViewOpen
}

interface Point { x: number; y: number }

export function clampFloatingPreviewPosition(point: Point, available: Point): Point {
  return {
    x: Math.round(Math.max(0, Math.min(point.x, available.x))),
    y: Math.round(Math.max(0, Math.min(point.y, available.y))),
  }
}
