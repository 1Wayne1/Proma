const listeners = new Set<() => void>()

/** 只发布本机资源归属变化；不依赖 watcher，避免 manager 之间的循环导入。 */
export function notifyWorkspaceResourcesChanged(): void {
  for (const listener of listeners) { try { listener() } catch { /* 观察者不能阻止配置落盘。 */ } }
}
export function subscribeWorkspaceResourcesChanged(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
