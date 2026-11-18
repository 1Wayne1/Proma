import { isValidImageBytes } from './image-content-validation'
import type { PromaSelfBounds, PromaSelfControl } from './proma-self-control-policy'

export interface PromaSelfScreenshot {
  mimeType: 'image/png'
  base64: string
  width: number
  height: number
  redacted: true
}

export interface PromaSelfScreenshotControl extends PromaSelfBounds {
  label: PromaSelfControl['label']
  tag: PromaSelfControl['tag']
}

/** 从实时布局先遮盖、后栅格化，整个过程不采集原始页面像素或动态文案。 */
export function buildPromaSelfScreenshot(controls: PromaSelfScreenshotControl[]): string {
  return `(${PROMA_SELF_SCREENSHOT}).call(undefined, ${JSON.stringify(controls)})`
}

const PROMA_SELF_SCREENSHOT = `function (controls) {
  const width = innerWidth, height = innerHeight;
  if (!width || !height) return null;
  const scale = Math.min(1, 1600 / width, 1000 / height);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.floor(width * scale));
  canvas.height = Math.max(1, Math.floor(height * scale));
  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) return null;
  ctx.fillStyle = '#262a30';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.scale(scale, scale);
  for (const box of controls) {
    ctx.fillStyle = box.tag === 'div' ? '#363b43' : '#f4f6f8';
    ctx.fillRect(box.x, box.y, box.width, box.height);
    ctx.font = '13px sans-serif';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = box.tag === 'div' ? '#f4f6f8' : '#202630';
    if (box.width > 16 && box.height >= 16) ctx.fillText(box.label, box.x + 7, box.y + Math.min(14, box.height / 2), box.width - 14);
  }
  return canvas.toDataURL('image/png');
}`

export function readPromaSelfScreenshot(value: unknown): PromaSelfScreenshot {
  const prefix = 'data:image/png;base64,'
  if (typeof value !== 'string' || !value.startsWith(prefix) || value.length > 2 * 1024 * 1024) {
    throw new Error('Proma 脱敏截图为空或超过大小限制')
  }
  const base64 = value.slice(prefix.length)
  const bytes = Buffer.from(base64, 'base64')
  if (bytes.toString('base64') !== base64 || !isValidImageBytes('image/png', bytes)) throw new Error('Proma 脱敏截图格式无效')
  const width = bytes.readUInt32BE(16)
  const height = bytes.readUInt32BE(20)
  if (width < 1 || width > 1600 || height < 1 || height > 1000) throw new Error('Proma 脱敏截图尺寸无效')
  return { mimeType: 'image/png', base64, width, height, redacted: true }
}
