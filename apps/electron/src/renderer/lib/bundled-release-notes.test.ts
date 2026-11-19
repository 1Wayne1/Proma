import { describe, expect, test } from 'bun:test'
import { collectBundledReleaseNotes, selectBundledReleaseNote } from './bundled-release-notes'

describe('随包更新日志', () => {
  const notes = collectBundledReleaseNotes({
    '/release-notes/v0.16.9.md': '较早的说明',
    '/release-notes/v0.16.10.md': '最近的说明',
    '/release-notes/v0.17.0.md': '  ',
    '/release-notes/v0.18.0-beta.md': '预发布说明',
    '/release-notes/README.md': '目录说明',
  })

  test('给定多个随包文件，按数字版本倒序列出有效正文', () => {
    expect(notes).toEqual([
      { version: '0.16.10', markdown: '最近的说明' },
      { version: '0.16.9', markdown: '较早的说明' },
    ])
    expect(selectBundledReleaseNote(notes)?.version).toBe('0.16.10')
  })

  test('给定具体版本，只打开该版本，不将历史日志冒充为新版说明', () => {
    expect(selectBundledReleaseNote(notes, 'v0.16.9')?.markdown).toBe('较早的说明')
    expect(selectBundledReleaseNote(notes, '0.19.84')).toBeUndefined()
    expect(selectBundledReleaseNote([])).toBeUndefined()
  })
})
