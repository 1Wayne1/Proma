import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { NETWORK_IPC_CHANNELS } from '@proma/shared'
import { registerNetworkIpcHandlers } from '../network-ipc'
import '../../../../preload/index'
import { app, getApi, ipcRenderer, invokeAs, sender, state } from './network-ipc-stubs'

async function verify(): Promise<void> {
  state.destination = process.argv[2]!
  registerNetworkIpcHandlers()
  const api = getApi()
  assert.equal((await api.getNetworkStatus()).endpoints.length, 0)
  await assert.rejects(invokeAs(NETWORK_IPC_CHANNELS.GET_STATUS, { sender, senderFrame: {} }), /主窗口/)
  await assert.rejects(api.checkNetworkConnection({ requestId: 'invalid', channelId: 'missing' }), /渠道/)
  let updates = 0
  const release = api.onNetworkStatusChanged(() => { updates += 1 })
  const snapshot = await api.checkNetworkConnection({ requestId: 'request-1', channelId: 'fixture' })
  assert.equal(snapshot.endpoints[0]?.httpStatus, 401)
  assert.equal(snapshot.endpoints[0]?.state, 'reachable')
  assert.deepEqual(state.requests, [{ input: 'https://example.test', method: 'HEAD', credentials: 'omit', redirect: 'manual', hasHeaders: false }])
  assert.equal(updates, 2)
  release()
  await api.notifyNetworkOnline(false)
  assert.equal(updates, 2)
  assert.equal(ipcRenderer.listenerCount(NETWORK_IPC_CHANNELS.STATUS_CHANGED), 0)
  const preview = await api.previewNetworkDiagnostics()
  await api.notifyNetworkOnline(true)
  state.canceled = true
  assert.deepEqual(await api.exportNetworkDiagnostics(preview.previewId), { status: 'cancelled' })
  assert.equal(existsSync(state.destination), false)
  state.canceled = false
  assert.deepEqual(await api.exportNetworkDiagnostics(preview.previewId), { status: 'saved' })
  const saved = readFileSync(state.destination, 'utf8')
  assert.deepEqual(JSON.parse(saved), preview.report)
  assert.ok(!/private-password|private-key|example\.test|api_key/.test(saved))
  state.duringDialog = async () => { await api.previewNetworkDiagnostics() }
  await assert.rejects(api.exportNetworkDiagnostics(preview.previewId), /失效/)
  assert.equal(readFileSync(state.destination, 'utf8'), saved)
  let completeFetch!: (response: Response) => void
  let markStarted!: () => void
  const started = new Promise<void>(resolve => { markStarted = resolve })
  state.nextFetch = () => { markStarted(); return new Promise(resolve => { completeFetch = resolve }) }
  const checking = api.checkNetworkConnection({ requestId: 'cancel-me', channelId: 'fixture' })
  await started
  await api.cancelNetworkCheck('another-request')
  assert.equal((await api.getNetworkStatus()).endpoints.find(item => item.source === 'probe')?.state, 'checking')
  await api.cancelNetworkCheck('cancel-me')
  assert.equal((await checking).endpoints.find(item => item.source === 'probe')?.state, 'cancelled')
  completeFetch(new Response(null, { status: 200 }))
  await Promise.resolve()
  assert.equal((await api.getNetworkStatus()).endpoints.find(item => item.source === 'probe')?.state, 'cancelled')
  assert.equal(sender.listenerCount('destroyed'), 0)

  // 显式网络重连四层契约：主窗口校验、参数校验、并发合并、取消与零远程探测
  await assert.rejects(invokeAs(NETWORK_IPC_CHANNELS.RECONNECT, { sender, senderFrame: {} }), /主窗口/)
  await assert.rejects(invokeAs(NETWORK_IPC_CHANNELS.CANCEL_RECONNECT, { sender, senderFrame: {} }), /主窗口/)
  await assert.rejects(api.reconnectNetwork({ requestId: 'bad id with space' }), /重连/)
  await assert.rejects(api.cancelNetworkReconnect('bad id with space'), /重连/)

  let releaseReconnectProxy!: () => void
  let markReconnectStarted!: () => void
  const reconnectStarted = new Promise<void>(resolve => { markReconnectStarted = resolve })
  state.nextReconnectProxy = () => {
    markReconnectStarted()
    return new Promise<void>(resolve => { releaseReconnectProxy = resolve })
  }
  const requestCountBeforeReconnect = state.requests.length
  const firstReconnect = api.reconnectNetwork({ requestId: 'r1' })
  await reconnectStarted
  const secondReconnect = api.reconnectNetwork({ requestId: 'r2' })
  releaseReconnectProxy()
  const [snap1, snap2] = await Promise.all([firstReconnect, secondReconnect])
  assert.equal(snap1.reconnect?.state, 'ready')
  assert.equal(snap1.reconnect?.epoch, 1)
  assert.equal(snap2.reconnect?.epoch, 1)
  assert.deepEqual(state.reconnectCalls, {
    invalidateProxy: 1,
    getProxy: 1,
    defaultProxyReload: 1,
    defaultDnsClear: 1,
    browserRefresh: 1,
    mcpReconnect: 1,
  })
  assert.equal(state.requests.length, requestCountBeforeReconnect)

  state.nextReconnectProxy = undefined
  const noArgReconnect = await api.reconnectNetwork()
  assert.equal(noArgReconnect.reconnect?.state, 'ready')
  assert.equal(noArgReconnect.reconnect?.epoch, 2)

  let finishSlowReconnect!: () => void
  let markSlowStarted!: () => void
  const slowStarted = new Promise<void>(resolve => { markSlowStarted = resolve })
  state.nextReconnectProxy = () => {
    markSlowStarted()
    return new Promise<void>(resolve => { finishSlowReconnect = resolve })
  }
  const pendingReconnect = api.reconnectNetwork({ requestId: 'cancel-reconnect' })
  await slowStarted
  await api.cancelNetworkReconnect('wrong-reconnect-id')
  assert.equal((await api.getNetworkStatus()).reconnect?.state, 'reconnecting')
  await api.cancelNetworkReconnect('cancel-reconnect')
  const cancelledReconnect = await pendingReconnect
  assert.equal(cancelledReconnect.reconnect?.state, 'cancelled')
  assert.equal(cancelledReconnect.reconnect?.epoch, 2)
  finishSlowReconnect()
  await Promise.resolve()
  assert.equal((await api.getNetworkStatus()).reconnect?.state, 'cancelled')
  assert.equal(sender.listenerCount('destroyed'), 0)

  const reconnectPreview = await api.previewNetworkDiagnostics()
  assert.equal(reconnectPreview.report.snapshot.reconnect?.state, 'cancelled')
  assert.ok(!/private-password|private-key|example\.test|api_key/.test(JSON.stringify(reconnectPreview)))

  app.emit('before-quit')
  await assert.rejects(api.getNetworkStatus(), /registered/)
  await assert.rejects(api.reconnectNetwork(), /registered/)
  console.log('network-ipc: passed')
}

verify().catch(error => { console.error(error); process.exitCode = 1 })
