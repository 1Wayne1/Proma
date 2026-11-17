import type { TurnFileChange, TurnFileSnapshot } from '@proma/shared'

export function compareTurnFile(path: string, before: TurnFileSnapshot, after: TurnFileSnapshot, source: TurnFileChange['source']): TurnFileChange | undefined {
  if (before.availability === 'missing' && after.availability === 'missing') return undefined
  if (before.availability === 'available' && after.availability === 'available' && before.hash === after.hash) return undefined
  let kind: TurnFileChange['kind'] = 'unknown'
  if (before.availability === 'missing' && after.availability === 'available') kind = 'added'
  else if (before.availability === 'available' && after.availability === 'missing') kind = 'deleted'
  else if (before.availability === 'available' && after.availability === 'available') kind = 'modified'
  return { path, before: { ...before }, after: { ...after }, source, kind }
}
