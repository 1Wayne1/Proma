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
  app.emit('before-quit')
  await assert.rejects(api.getNetworkStatus(), /registered/)
  console.log('network-ipc: passed')
}

verify().catch(error => { console.error(error); process.exitCode = 1 })
