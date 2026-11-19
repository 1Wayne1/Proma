import * as React from 'react'
import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import type { NetworkEndpointState, NetworkFailureKind, NetworkReconnectState } from '@proma/shared'
import { Button } from '@/components/ui/button'
import { channelsAtom } from '@/atoms/chat-atoms'
import { acceptNetworkStatusAtom, connectNetworkStatus, networkDiagnosticPreviewAtom, networkStatusAtom } from '@/atoms/network-atoms'
import { SettingsCard, SettingsSection } from './primitives'

const stateLabels: Record<NetworkEndpointState, string> = {
  checking: '检查中', reachable: '连接可达', failed: '连接失败', closed: '连接已关闭', cancelled: '已取消',
}
const reconnectLabels: Record<NetworkReconnectState, string> = {
  idle: '待命', reconnecting: '重连中', ready: '已就绪', failed: '重连失败', cancelled: '已取消',
}
const failureLabels: Record<NetworkFailureKind, string> = {
  cancelled: '已取消', authentication: '认证失败', permission: '访问被拒绝', quota: '额度不足', validation: '请求或配置错误',
  tls: '证书错误', 'rate-limit': '请求限流', timeout: '连接超时', connection: '连接中断', unknown: '原因未确认',
}

export function NetworkDiagnosticsSettings(): React.ReactElement {
  const status = useAtomValue(networkStatusAtom)
  const accept = useSetAtom(acceptNetworkStatusAtom)
  const channels = useAtomValue(channelsAtom)
  const [preview, setPreview] = useAtom(networkDiagnosticPreviewAtom)
  const [channelId, setChannelId] = React.useState('')
  const [busy, setBusy] = React.useState<'check' | 'reconnect' | 'preview' | 'export' | null>(null)
  const [message, setMessage] = React.useState('')
  const request = React.useRef<string | null>(null)
  const reconnectRequest = React.useRef<string | null>(null)
  const live = React.useRef(false)
  const lifecycle = React.useRef(0)
  React.useEffect(() => {
    live.current = true
    const generation = ++lifecycle.current
    const release = connectNetworkStatus(window.electronAPI, accept, () => setMessage('网络状态读取失败，请重新打开设置重试'))
    const notify = (): void => { void window.electronAPI.notifyNetworkOnline(navigator.onLine).then(snapshot => { if (live.current && lifecycle.current === generation) accept(snapshot) }).catch(() => {}) }
    notify()
    window.addEventListener('online', notify)
    window.addEventListener('offline', notify)
    return () => {
      live.current = false
      lifecycle.current += 1
      release()
      window.removeEventListener('online', notify)
      window.removeEventListener('offline', notify)
      if (request.current) void window.electronAPI.cancelNetworkCheck(request.current).catch(() => {})
      if (reconnectRequest.current) void window.electronAPI.cancelNetworkReconnect(reconnectRequest.current).catch(() => {})
    }
  }, [accept])

  const perform = async (action: 'check' | 'reconnect' | 'preview' | 'export'): Promise<void> => {
    const generation = lifecycle.current
    const isCurrent = (): boolean => live.current && lifecycle.current === generation
    setBusy(action)
    setMessage('')
    try {
      if (action === 'check') {
        setPreview(null)
        const id = crypto.randomUUID()
        request.current = id
        const snapshot = await window.electronAPI.checkNetworkConnection({ requestId: id, channelId })
        if (isCurrent() && request.current === id) accept(snapshot)
      } else if (action === 'reconnect') {
        setPreview(null)
        const id = crypto.randomUUID()
        reconnectRequest.current = id
        const snapshot = await window.electronAPI.reconnectNetwork({ requestId: id })
        if (isCurrent() && reconnectRequest.current === id) {
          accept(snapshot)
          const reconnect = snapshot.reconnect
          if (reconnect?.state === 'ready') setMessage(`已完成第 ${reconnect.epoch} 轮本地网络刷新`)
          else if (reconnect?.state === 'cancelled') setMessage('已取消重新连接')
          else if (reconnect?.state === 'failed') {
            setMessage(reconnect.failureKind ? `重新连接未完成：${failureLabels[reconnect.failureKind]}` : '重新连接未完成，请检查代理与网络设置')
          }
        }
      } else if (action === 'preview') {
        const value = await window.electronAPI.previewNetworkDiagnostics()
        if (isCurrent()) setPreview(value)
      } else if (preview) {
        const result = await window.electronAPI.exportNetworkDiagnostics(preview.previewId)
        if (isCurrent()) setMessage(result.status === 'saved' ? '已导出当前预览的诊断' : '已取消导出')
      }
    } catch {
      if (isCurrent()) {
        if (action === 'check') setMessage('检查未完成，请确认渠道地址和代理设置')
        else if (action === 'reconnect') setMessage('重新连接未完成，请检查网络或代理设置')
        else setMessage('操作未完成，请重新预览后重试')
      }
    } finally {
      if (isCurrent()) {
        if (action === 'check') request.current = null
        if (action === 'reconnect') reconnectRequest.current = null
        setBusy(null)
      }
    }
  }

  const eligible = channels.filter(channel => channel.baseUrl && /^https?:/i.test(channel.baseUrl))
  const validSelection = eligible.some(channel => channel.id === channelId)
  return <SettingsSection title="网络状态与诊断" description="查看 HTTP 与 MCP 连接记录，或检查所选渠道的服务源。">
    <SettingsCard divided={false}>
      <div className="space-y-3 p-4">
        <p className="text-sm">系统联网提示：{status?.onlineHint === null || !status ? '未知' : status.onlineHint ? '系统报告可联网' : '系统报告离线'}</p>
        {status?.reconnect && (
          <p className="text-xs text-muted-foreground">
            本地重连状态：{reconnectLabels[status.reconnect.state]}（第 {status.reconnect.epoch} 轮）
            {status.reconnect.failureKind && status.reconnect.state !== 'cancelled' && ` · ${failureLabels[status.reconnect.failureKind]}`}
          </p>
        )}
        <p className="text-xs text-muted-foreground">检查只访问渠道的服务源，不发送模型密钥、不跟随跳转。收到 HTTP 响应表示可达，不代表模型认证或工具执行成功。</p>
        <p className="text-xs text-muted-foreground">重新连接会刷新本地代理缓存、浏览器网络配置并清理空闲网络 MCP 连接，不中断活跃任务、不重放有副作用调用、不访问云端服务。</p>
        <label className="block text-sm" htmlFor="network-check-channel">选择已有渠道</label>
        <select id="network-check-channel" value={channelId} onChange={event => setChannelId(event.target.value)} disabled={busy !== null}
          className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm">
          <option value="">{eligible.length ? '请选择渠道' : '暂无可检查的 HTTP 渠道'}</option>
          {eligible.map(channel => <option key={channel.id} value={channel.id}>{channel.name}</option>)}
        </select>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" disabled={busy !== null} onClick={() => { void perform('reconnect') }}>{busy === 'reconnect' ? '重连中…' : '重新连接'}</Button>
          {busy === 'reconnect' && <Button variant="outline" size="sm" onClick={() => {
            const generation = lifecycle.current
            if (reconnectRequest.current) void window.electronAPI.cancelNetworkReconnect(reconnectRequest.current).then(() => {
              if (live.current && lifecycle.current === generation) setMessage('已请求取消重连')
            }).catch(() => { if (live.current && lifecycle.current === generation) setMessage('取消未完成，请稍后重试') })
          }}>取消重连</Button>}
          <Button variant="outline" size="sm" disabled={busy !== null || !validSelection} onClick={() => { void perform('check') }}>{busy === 'check' ? '检查中…' : '检查连接'}</Button>
          {busy === 'check' && <Button variant="outline" size="sm" onClick={() => {
            const generation = lifecycle.current
            if (request.current) void window.electronAPI.cancelNetworkCheck(request.current).then(() => {
              if (live.current && lifecycle.current === generation) setMessage('已请求取消检查')
            }).catch(() => { if (live.current && lifecycle.current === generation) setMessage('取消未完成，请稍后重试') })
          }}>取消检查</Button>}
          <Button variant="outline" size="sm" disabled={busy !== null} onClick={() => { void perform('preview') }}>预览诊断</Button>
          <Button variant="outline" size="sm" disabled={busy !== null || !preview} onClick={() => { void perform('export') }}>导出当前预览</Button>
        </div>
        <div aria-live="polite" role="status" className="text-xs text-muted-foreground">{message}</div>
        {!status?.endpoints.length && <p className="text-sm text-muted-foreground">尚无连接记录。可检查一个渠道，或在使用 MCP 后查看。</p>}
        <ul className="space-y-2 text-xs" aria-label="最近的连接记录">
          {status?.endpoints.slice().reverse().map(endpoint => <li key={endpoint.id}>
            {endpoint.source === 'mcp' ? 'MCP' : endpoint.source === 'probe' ? '渠道检查' : 'HTTP'} · {endpoint.id.slice(0, 6)}：{stateLabels[endpoint.state]}
            {endpoint.httpStatus !== undefined && `（HTTP ${endpoint.httpStatus}）`}
            {endpoint.failureKind && ` · ${failureLabels[endpoint.failureKind]}`}
          </li>)}
        </ul>
        {preview && <div className="space-y-2">
          <p className="text-xs text-muted-foreground">以下为将要导出的完整内容，不含地址、渠道名、凭据或响应正文。</p>
          <pre tabIndex={0} aria-label="网络诊断预览" className="max-h-64 overflow-auto rounded-md border border-border bg-muted/30 p-3 text-xs">{JSON.stringify(preview.report, null, 2)}</pre>
        </div>}
      </div>
    </SettingsCard>
  </SettingsSection>
}
