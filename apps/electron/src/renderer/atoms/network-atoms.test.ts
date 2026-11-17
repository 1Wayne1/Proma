import { describe, expect, test } from 'bun:test'
import { createStore } from 'jotai'
import type { NetworkStatusSnapshot } from '@proma/shared'
import { acceptNetworkStatusAtom, connectNetworkStatus, networkStatusAtom } from './network-atoms'

describe('网络状态订阅', () => {
  test('Given 读取比推送迟到 When 接收旧 revision Then 保留新的推送', async () => {
    const store = createStore()
    let finish!: (snapshot: NetworkStatusSnapshot) => void
    let callback!: (snapshot: NetworkStatusSnapshot) => void
    let releases = 0
    const release = connectNetworkStatus({
      getNetworkStatus: () => new Promise(resolve => { finish = resolve }),
      onNetworkStatusChanged: listener => { callback = listener; return () => { releases += 1 } },
    }, snapshot => store.set(acceptNetworkStatusAtom, snapshot), () => { throw new Error('unexpected failure') })
    callback({ revision: 2, onlineHint: false, endpoints: [] })
    finish({ revision: 1, onlineHint: true, endpoints: [] })
    await Promise.resolve()
    expect(store.get(networkStatusAtom)?.revision).toBe(2)
    release()
    callback({ revision: 3, onlineHint: true, endpoints: [] })
    expect(store.get(networkStatusAtom)?.revision).toBe(2)
    expect(releases).toBe(1)
  })
  test('Given 已卸载 When 初始读取失败 Then 不再通知 UI', async () => {
    let fail!: (reason: Error) => void
    let errors = 0
    const release = connectNetworkStatus({ getNetworkStatus: () => new Promise((_, reject) => { fail = reject }), onNetworkStatusChanged: () => () => {} }, () => {}, () => { errors += 1 })
    release()
    fail(new Error('late'))
    await Promise.resolve()
    await Promise.resolve()
    expect(errors).toBe(0)
  })
})
