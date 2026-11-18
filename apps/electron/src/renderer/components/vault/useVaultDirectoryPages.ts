import * as React from 'react'
import { atom, useAtomValue, useStore } from 'jotai'
import type { VaultDirectoryPage, VaultTreeEntry } from '@proma/shared'

interface DirectoryState {
  vaultId: string | null
  folders: Map<string, VaultDirectoryPage>
  pinned: VaultTreeEntry[]
  pending: Set<string>
  errors: Map<string, string>
}

function empty(vaultId: string | null): DirectoryState {
  return { vaultId, folders: new Map(), pinned: [], pending: new Set(), errors: new Map() }
}

export function useVaultDirectoryPages() {
  const stateAtom = React.useMemo(() => atom(empty(null)), [])
  const store = useStore()
  const state = useAtomValue(stateAtom)
  const generation = React.useRef(0)
  React.useEffect(() => () => { generation.current += 1 }, [])

  const activate = React.useCallback((vaultId: string | null) => {
    if (store.get(stateAtom).vaultId === vaultId) return
    generation.current += 1
    store.set(stateAtom, empty(vaultId))
  }, [stateAtom, store])

  const load = React.useCallback(async (id: string, folder: string, mode: 'first' | 'more' | 'ensure' = 'ensure'): Promise<void> => {
    const state = store.get(stateAtom)
    if (state.vaultId !== id || state.pending.has(folder)) return
    const previous = state.folders.get(folder)
    if (mode === 'ensure' && previous) return
    const cursor = mode === 'more' ? previous?.nextCursor : undefined
    if (mode === 'more' && !cursor) return
    const requestGeneration = generation.current
    store.set(stateAtom, current => ({ ...current, pending: new Set(current.pending).add(folder) }))
    try {
      const page = await window.electronAPI.listVaultDirectory(id, folder, cursor ?? undefined)
      if (requestGeneration !== generation.current) return
      store.set(stateAtom, current => {
        const folders = new Map(current.folders)
        const errors = new Map(current.errors)
        errors.delete(folder)
        folders.set(folder, { ...page, entries: cursor ? [...(previous?.entries ?? []), ...page.entries] : page.entries })
        return { ...current, folders, errors }
      })
    } catch (error) {
      if (requestGeneration !== generation.current) return
      const message = error instanceof Error ? error.message : '读取目录失败'
      store.set(stateAtom, current => ({ ...current, errors: new Map(current.errors).set(folder, message) }))
    } finally {
      if (requestGeneration === generation.current) {
        store.set(stateAtom, current => {
          const pending = new Set(current.pending)
          pending.delete(folder)
          return { ...current, pending }
        })
      }
    }
  }, [stateAtom, store])

  const refreshLoaded = React.useCallback(async (id: string): Promise<void> => {
    const current = store.get(stateAtom)
    if (current.vaultId !== id) return
    const paths = ['', ...[...current.folders.keys()].filter(path => path)]
    // 顺序更新已访问目录；未展开目录不读取。
    for (const path of paths) await load(id, path, 'first')
  }, [load, stateAtom, store])

  const pin = React.useCallback((id: string, entries: VaultTreeEntry[]): void => {
    store.set(stateAtom, current => current.vaultId === id ? { ...current, pinned: entries } : current)
  }, [stateAtom, store])

  const entries = React.useMemo(() => {
    const visible = new Map(state.pinned.map(entry => [entry.relativePath, entry]))
    for (const folder of state.folders.values()) {
      for (const entry of folder.entries) visible.set(entry.relativePath, entry)
    }
    return [...visible.values()]
  }, [state.folders, state.pinned])

  return { activate, load, refreshLoaded, pin, entries, folders: state.folders, pending: state.pending, errors: state.errors }
}

interface VaultNavigation {
  file: string | null
  folder: string | null
}

export function readVaultNavigation(vaultId: string, scope: string): VaultNavigation | null {
  try {
    const value = JSON.parse(localStorage.getItem(navigationKey(vaultId, scope)) ?? 'null') as Partial<VaultNavigation> | null
    if (!value) return null
    return { file: typeof value.file === 'string' ? value.file : null, folder: typeof value.folder === 'string' ? value.folder : null }
  } catch { return null }
}

export function storeVaultNavigation(vaultId: string, scope: string, value: VaultNavigation): void {
  try { localStorage.setItem(navigationKey(vaultId, scope), JSON.stringify(value)) } catch { /* 存储不可用时保留当前会话导航。 */ }
}

function navigationKey(vaultId: string, scope: string): string {
  return `proma:vault-navigation:${JSON.stringify([vaultId, scope])}`
}
