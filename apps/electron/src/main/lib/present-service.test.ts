import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PresentService } from './present-service'
import type { PresentAuthority } from './present-service'

describe('Present 交付登记与回执', () => {
  let temp: string
  let root: string
  let outside: string
  let config: string
  let scope: PresentAuthority | undefined
  let service: PresentService
  const owner = { sessionId: '本会话', turnId: '本轮' }

  beforeEach(() => {
    temp = mkdtempSync(join(realpathSync(tmpdir()), 'proma-present-'))
    root = join(temp, 'project')
    outside = join(temp, 'outside')
    config = join(temp, 'config')
    for (const dir of [root, outside, config]) mkdirSync(dir)
    scope = { cwd: root, directories: [root], files: [], vault: { id: 'vault', path: root } }
    service = new PresentService(id => id === owner.sessionId ? scope : undefined, () => {}, () => config)
  })
  afterEach(() => {
    service.releaseSession(owner.sessionId)
    rmSync(temp, { recursive: true, force: true })
  })

  test('Given 同一文件的相对和绝对路径 When 声明、确认和重启 Then 只保留一个交付资源及状态', () => {
    const path = join(root, '交付.md')
    writeFileSync(path, '原始输出')
    const records = service.declare(owner, [{ path, description: '交付说明' }, { path: './交付.md' }])
    expect(records).toHaveLength(1)
    const file = records[0]!
    expect(file).toMatchObject({ name: '交付.md', extension: 'md', description: '交付说明', status: 'pending', vaultAvailable: true })
    expect(readFileSync(path, 'utf8')).toBe('原始输出')
    const attempt = service.begin(owner, file.id, 'open')
    expect(service.list(owner)[0]?.status).toBe('opening')
    expect(service.verify(attempt)).toBe(path)
    expect(service.settle(attempt, 'presented')).toBe(true)
    const restarted = new PresentService(() => scope, () => {}, () => config)
    expect(restarted.list(owner)[0]?.status).toBe('presented')
    expect(restarted.list({ ...owner, turnId: '下轮' })).toEqual([])
  })

  test('Given 目录链接指向根外 When 一次声明多个文件 Then 拒绝整个请求', () => {
    writeFileSync(join(root, '可交付.md'), '项目内容')
    writeFileSync(join(outside, '外部.md'), '外部内容')
    symlinkSync(outside, join(root, 'link'), process.platform === 'win32' ? 'junction' : 'dir')
    expect(() => service.declare(owner, [{ path: '可交付.md' }, { path: 'link/外部.md' }])).toThrow('授权范围')
    expect(service.list(owner)).toEqual([])
    expect(() => service.declare(owner, [{ path: '.' }])).toThrow('普通文件')
  })

  test('Given 用户只附加单一文件 When 声明 Then 邻居文件与浏览器目录未获授权', () => {
    const html = join(outside, 'report.html')
    writeFileSync(html, '<p>结果</p>')
    writeFileSync(join(outside, 'other.html'), '<p>邻居</p>')
    scope!.files.push(html)
    const file = service.declare(owner, [{ path: html }])[0]!
    expect(file.browserAvailable).toBe(false)
    expect(() => service.begin(owner, file.id, 'browser')).toThrow('不能在受管浏览器')
    expect(() => service.declare(owner, [{ path: join(outside, 'other.html') }])).toThrow('授权范围')
  })

  test('Given 文件在确认后被替换 When 展示或定位 Then 旧身份失效，声明新版取消旧打开', () => {
    const path = join(root, 'report.html')
    writeFileSync(path, '<p>第一版</p>')
    const file = service.declare(owner, [{ path }])[0]!
    const attempt = service.begin(owner, file.id, 'browser')
    renameSync(path, join(root, 'old.html'))
    writeFileSync(path, '<p>第二版</p>')
    expect(() => service.verify(attempt)).toThrow('文件已变化')
    expect(service.list(owner)[0]?.status).toBe('unavailable')
    expect(() => service.begin(owner, file.id, 'locate')).toThrow('失去授权')
    const updated = service.declare(owner, [{ path }])[0]!
    expect(attempt.signal.aborted).toBe(true)
    expect(service.settle(attempt, 'presented')).toBe(false)
    expect(updated.id).toBe(file.id)
    rmSync(path)
    expect(service.list(owner)[0]?.status).toBe('unavailable')
  })

  test('Given 同一会话两次 Vault 展示 When 旧窗口延迟回执 Then 只确认当前请求', () => {
    writeFileSync(join(root, 'first.md'), '旧')
    writeFileSync(join(root, 'second.md'), '新')
    const [first, second] = service.declare(owner, [{ path: 'first.md' }, { path: 'second.md' }])
    const old = service.begin(owner, first!.id, 'vault')
    const current = service.begin(owner, second!.id, 'vault')
    expect(old.signal.aborted).toBe(true)
    expect(service.vaultReceipt(owner, old.id, 'presented')).toBe(false)
    expect(service.vaultReceipt({ ...owner, turnId: '旧轮' }, current.id, 'presented')).toBe(false)
    expect(service.vaultReceipt(owner, current.id, 'presented')).toBe(true)
    expect(service.list(owner).map(file => file.status)).toEqual(['cancelled', 'presented'])
    expect(service.vaultReceipt(owner, current.id, 'cancelled')).toBe(false)
  })

  test('Given 浏览器预览仍在加载 When 发起更新的预览 Then 旧请求中止且不能确认新版', () => {
    writeFileSync(join(root, 'first.html'), '<p>旧</p>')
    writeFileSync(join(root, 'second.html'), '<p>新</p>')
    const [first, second] = service.declare(owner, [{ path: 'first.html' }, { path: 'second.html' }])
    const old = service.begin(owner, first!.id, 'browser')
    const current = service.begin(owner, second!.id, 'browser')
    expect(old.signal.aborted).toBe(true)
    expect(service.settle(old, 'presented')).toBe(false)
    expect(service.settle(current, 'presented')).toBe(true)
    expect(service.list(owner).map(file => file.status)).toEqual(['cancelled', 'presented'])
  })

  test('Given 有活动展示与历史记录 When 删除会话 Then 取消请求并清理该会话私有记录', () => {
    writeFileSync(join(root, '结果.md'), '输出')
    const [resource] = service.declare(owner, [{ path: '结果.md' }])
    const attempt = service.begin(owner, resource!.id, 'vault')
    scope = undefined
    service.purgeSession(owner.sessionId)
    expect(attempt.signal.aborted).toBe(true)
    expect(service.vaultReceipt(owner, attempt.id, 'presented')).toBe(false)
    expect(service.list(owner)).toEqual([])
    expect(existsSync(join(root, '结果.md'))).toBe(true)
  })
})
