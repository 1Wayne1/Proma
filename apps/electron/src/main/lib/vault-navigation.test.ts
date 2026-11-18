import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createVaultFileSystem } from './vault-service'

describe('Vault 分页和定位', () => {
  let fixture: string
  let root: string
  let vault: ReturnType<typeof createVaultFileSystem>
  const note = (path: string): void => {
    const absolute = join(root, path)
    mkdirSync(dirname(absolute), { recursive: true })
    writeFileSync(absolute, '# 笔记')
  }

  beforeEach(() => {
    fixture = mkdtempSync(join(realpathSync(tmpdir()), 'proma-vault-pages-'))
    root = join(fixture, 'vault')
    mkdirSync(root)
    vault = createVaultFileSystem(root)
  })
  afterEach(() => rmSync(fixture, { recursive: true, force: true }))

  test('Given 文件夹超过一页且有后代 When 分页 Then 仅加载本层，定位能返回未加载条目的祖先', () => {
    note('专题/下一层/笔记.md')
    for (let i = 0; i < 120; i++) note(`专题/条目 ${i}.md`)
    const rootPage = vault.listDirectory('')
    expect(rootPage.entries.map(entry => entry.relativePath)).toEqual(['专题'])
    const first = vault.listDirectory('专题')
    expect(first.entries).toHaveLength(100)
    expect(first.entries[0]?.relativePath).toBe('专题/下一层')
    expect(first.nextCursor).not.toBeNull()
    const next = vault.listDirectory('专题', first.nextCursor!)
    expect(next.entries).toHaveLength(21)
    expect(next.nextCursor).toBeNull()
    expect(new Set([...first.entries, ...next.entries].map(entry => entry.relativePath)).size).toBe(121)
    const located = vault.locate('file', '专题/下一层/笔记.md')
    expect(located.entries.map(entry => entry.relativePath)).toEqual(['专题', '专题/下一层', '专题/下一层/笔记.md'])
    expect(vault.folderPath('专题')).toBe(join(root, '专题'))
  })

  test('Given 文件夹在两页之间发生变化 When 使用旧游标 Then 要求重新加载', () => {
    for (let i = 0; i < 101; i++) note(`条目 ${i}.md`)
    const old = vault.listDirectory('').nextCursor
    note('新笔记.md')
    utimesSync(root, new Date(), new Date(Date.now() - 60_000))
    expect(() => vault.listDirectory('', old!)).toThrow('文件夹已变化')
    expect(vault.listDirectory('').nextCursor).not.toBe(old)
  })

  test('Given 同名 Markdown When Wiki 解析 Then 无限定名称返回候选，显式路径可直接匹配', () => {
    note('来源/当前.md')
    note('工作/索引.md')
    note('个人/索引.md')
    expect(vault.resolveWiki('索引', '来源/当前.md')).toEqual({
      status: 'ambiguous', paths: ['个人/索引.md', '工作/索引.md'], partial: false,
    })
    expect(vault.resolveWiki('工作/索引', '来源/当前.md')).toEqual({ status: 'resolved', path: '工作/索引.md' })
    expect(vault.resolveWiki('../个人/索引.md', '来源/当前.md')).toEqual({ status: 'resolved', path: '个人/索引.md' })
    expect(vault.resolveWiki('../../外部', '来源/当前.md')).toEqual({ status: 'missing' })
  })

  test('Given 目录联接指向根外 When 分页、定位、解析或打开文件夹 Then 不访问联接目标', () => {
    note('内部/当前.md')
    const outside = join(fixture, 'outside')
    mkdirSync(outside)
    writeFileSync(join(outside, '秘密.md'), '外部')
    symlinkSync(outside, join(root, '外部'), process.platform === 'win32' ? 'junction' : 'dir')
    expect(vault.listDirectory('').entries.map(entry => entry.name)).toEqual(['内部'])
    expect(() => vault.locate('file', '外部/秘密.md')).toThrow('软链接')
    expect(() => vault.folderPath('外部')).toThrow('软链接')
    expect(vault.resolveWiki('外部/秘密', '内部/当前.md')).toEqual({ status: 'missing' })
    renameSync(root, join(fixture, 'old-vault'))
    mkdirSync(root)
    expect(() => vault.listDirectory('')).toThrow('根目录已变化')
  })
})
