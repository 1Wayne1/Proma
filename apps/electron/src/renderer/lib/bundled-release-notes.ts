export interface BundledReleaseNote {
  version: string
  markdown: string
}

export function collectBundledReleaseNotes(files: Record<string, string>): BundledReleaseNote[] {
  return Object.entries(files).flatMap(([path, markdown]) => {
    const version = /(?:^|\/)v(\d+\.\d+\.\d+)\.md$/.exec(path)?.[1]
    return version && markdown.trim() ? [{ version, markdown }] : []
  }).sort((first, second) => {
    const firstParts = first.version.split('.').map(Number)
    const secondParts = second.version.split('.').map(Number)
    for (const [index, part] of secondParts.entries()) {
      if (part !== firstParts[index]) return part - firstParts[index]!
    }
    return 0
  })
}

export function selectBundledReleaseNote(
  notes: readonly BundledReleaseNote[],
  version?: string,
): BundledReleaseNote | undefined {
  return version ? notes.find(note => note.version === version.replace(/^v/, '')) : notes[0]
}
