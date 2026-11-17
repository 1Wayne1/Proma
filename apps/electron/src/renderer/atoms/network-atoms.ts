import { atom } from 'jotai'
import type { NetworkDiagnosticPreview, NetworkStatusSnapshot } from '@proma/shared'

export const networkStatusAtom = atom<NetworkStatusSnapshot | null>(null)
export const networkDiagnosticPreviewAtom = atom<NetworkDiagnosticPreview | null>(null)
export const acceptNetworkStatusAtom = atom(null, (get, set, snapshot: NetworkStatusSnapshot) => {
  const previous = get(networkStatusAtom)
  if (!previous || snapshot.revision >= previous.revision) set(networkStatusAtom, snapshot)
})

interface NetworkStatusClient {
  getNetworkStatus: () => Promise<NetworkStatusSnapshot>
  onNetworkStatusChanged: (callback: (snapshot: NetworkStatusSnapshot) => void) => () => void
}

/** 先订阅再读取，迟到的读取结果交由 revision 门控；卸载后不再写状态。 */
export function connectNetworkStatus(
  client: NetworkStatusClient,
  apply: (snapshot: NetworkStatusSnapshot) => void,
  onError: () => void,
): () => void {
  let active = true
  const release = client.onNetworkStatusChanged(snapshot => { if (active) apply(snapshot) })
  void client.getNetworkStatus().then(snapshot => { if (active) apply(snapshot) }).catch(() => { if (active) onError() })
  return () => { active = false; release() }
}
