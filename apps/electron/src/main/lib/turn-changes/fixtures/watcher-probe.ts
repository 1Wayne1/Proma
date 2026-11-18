import assert from 'node:assert/strict'
import { mkdir, realpath, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { BrowserWindow } from 'electron'
import { startWorkspaceWatcher, stopWorkspaceWatcher } from '../../workspace-watcher'
import { notifyWorkspaceResourcesChanged } from '../../workspace-resource-events'
import { watchHost } from './watcher-host'

const pause = (ms: number): Promise<void> => new Promise(done => setTimeout(done, ms))
async function verify(): Promise<void> {
  const root = await realpath(process.argv[2]!)
  const shared = join(root, 'shared'); const next = join(root, 'next')
  watchHost.managed = join(root, 'managed')
  await mkdir(shared); await mkdir(next); await mkdir(watchHost.managed)
  const events: string[][] = []
  const win = { isDestroyed: () => false, webContents: { send: (_channel: string, paths?: string[]) => events.push(paths ?? []) } } as unknown as BrowserWindow
  watchHost.sessions = [{ id: 'a', attachedDirectories: [shared] }, { id: 'b', attachedDirectories: [shared] }]
  startWorkspaceWatcher(win)
  assert.equal(watchHost.watchers.filter(entry => entry.path === shared).length, 1)
  const changed = async (path: string, content: string): Promise<void> => {
    const count = events.length
    // macOS 的原生 watcher 没有就绪回调，刚注册时第一笔写入可能早于 FSEvents 开始收集。
    // 用实际写入等到目标路径送达，且不能用无关目录的事件满足断言。
    for (let attempt = 0; attempt < 5; attempt++) {
      await writeFile(path, `${content} ${attempt}`)
      await pause(650) // 留出原生事件与应用 300ms 防抖的投递时间。
      if (events.slice(count).some(paths => paths.includes(path))) return
    }
    assert.fail(`未收到目录事件: ${path}`)
  }
  await changed(join(shared, 'file.txt'), 'first')
  watchHost.sessions = [{ id: 'b', attachedDirectories: [shared] }]
  notifyWorkspaceResourcesChanged(); await pause(20)
  await changed(join(shared, 'file.txt'), 'still watched')
  watchHost.sessions = []; notifyWorkspaceResourcesChanged(); await pause(400)
  const count = events.length
  await writeFile(join(shared, 'file.txt'), 'released'); await pause(500)
  assert.equal(events.length, count)

  watchHost.sessions = [{ id: 'b', activeWorktree: { path: shared } }]
  notifyWorkspaceResourcesChanged(); await pause(20)
  await changed(join(shared, 'file.txt'), 'active tree')
  const oldWatcher = watchHost.watchers.filter(entry => entry.path === shared).at(-1)!.watcher
  watchHost.sessions = [{ id: 'b', activeWorktree: { path: next } }]
  notifyWorkspaceResourcesChanged(); await pause(400)
  await changed(join(next, 'file.txt'), 'new active tree')
  const afterSwitch = events.length
  await writeFile(join(shared, 'file.txt'), 'old root'); await pause(500)
  assert.equal(events.length, afterSwitch)
  oldWatcher.emit('error', new Error('late closed watcher'))
  assert.equal(watchHost.watchers.filter(entry => entry.path === shared).length, 2)

  const missing = join(root, 'missing')
  watchHost.sessions = [{ id: 'b', attachedDirectories: [missing] }]
  notifyWorkspaceResourcesChanged(); await pause(20)
  await mkdir(missing); await pause(400)
  await changed(join(missing, 'restored.txt'), 'recovered')
  // 真实 watcher 的错误回调安排自愈；取消引用后，五秒重试不能复活它。
  const current = watchHost.watchers.findLast(entry => entry.path === missing)!
  current.watcher.emit('error', new Error('fixture watcher error'))
  const parent = watchHost.watchers.findLast(entry => entry.path === root)!
  parent.watcher.emit('error', new Error('fixture parent error'))
  watchHost.sessions = []; notifyWorkspaceResourcesChanged(); await pause(400)
  const watcherCount = watchHost.watchers.length
  await pause(5200)
  assert.equal(watchHost.watchers.length, watcherCount)
  stopWorkspaceWatcher()
  const stoppedEvents = events.length
  notifyWorkspaceResourcesChanged(); await writeFile(join(missing, 'restored.txt'), 'stopped'); await pause(500)
  assert.equal(events.length, stoppedEvents)
  console.log('workspace-watch-lifecycle: passed')
}
void verify().catch(error => { stopWorkspaceWatcher(); console.error(error); process.exitCode = 1 })
