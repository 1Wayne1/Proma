import { canonicalProjectPath } from './project-mutation-guard'
import { turnPathKey } from './turn-changes/paths'

interface DirectorySubscription { path: string; owners: Set<string> }

/** 按显式所有者替换订阅集合，重复同步不增加引用；路径别名共享底层 watcher。 */
export class DirectoryWatchSubscriptions {
  private readonly entries = new Map<string, DirectorySubscription>()
  constructor(private readonly start: (path: string) => void, private readonly stop: (path: string) => void) {}

  sync(desired: ReadonlyMap<string, readonly string[]>): void {
    const next = new Map<string, DirectorySubscription>()
    for (const [owner, paths] of desired) for (const raw of paths) {
      if (!raw) continue
      const path = canonicalProjectPath(raw)
      const key = turnPathKey(path)
      let entry = next.get(key)
      if (!entry) { entry = { path, owners: new Set() }; next.set(key, entry) }
      entry.owners.add(owner)
    }
    for (const [key, entry] of this.entries) if (!next.has(key)) this.stop(entry.path)
    const previous = new Set(this.entries.keys())
    this.entries.clear()
    for (const [key, entry] of next) this.entries.set(key, entry)
    for (const [key, entry] of next) if (!previous.has(key)) this.start(entry.path)
  }

  has(path: string): boolean { return this.entries.has(turnPathKey(canonicalProjectPath(path))) }
  refCount(path: string): number { return this.entries.get(turnPathKey(canonicalProjectPath(path)))?.owners.size ?? 0 }
  clear(): void { for (const entry of this.entries.values()) this.stop(entry.path); this.entries.clear() }
}
