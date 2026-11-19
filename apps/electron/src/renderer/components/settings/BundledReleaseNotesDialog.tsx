import { atom, useAtom } from 'jotai'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { collectBundledReleaseNotes, selectBundledReleaseNote } from '@/lib/bundled-release-notes'
import { ReleaseNotesBody } from './ReleaseNotesViewer'

export const bundledReleaseNotesRequestAtom = atom<{ version?: string } | null>(null)

const notes = collectBundledReleaseNotes(import.meta.glob<string>(
  '../../../../../../release-notes/*.md',
  { eager: true, query: '?raw', import: 'default' },
))

export function BundledReleaseNotesDialog(): React.ReactElement {
  const [request, setRequest] = useAtom(bundledReleaseNotesRequestAtom)
  const selected = selectBundledReleaseNote(notes, request?.version)

  return (
    <Dialog open={request !== null} onOpenChange={open => { if (!open) setRequest(null) }}>
      <DialogContent className="max-h-[85vh] w-[calc(100%_-_2rem)] max-w-2xl grid-rows-[auto_minmax(0,1fr)]">
        <DialogHeader>
          <DialogTitle>更新日志</DialogTitle>
          <DialogDescription>此处只显示随应用附带的发布说明，可离线查看。</DialogDescription>
        </DialogHeader>
        <div className="min-h-0 space-y-3 overflow-y-auto pr-2">
          {request?.version && !selected && (
            <p className="text-sm text-muted-foreground">安装包未附带 v{request.version.replace(/^v/, '')} 的更新说明。</p>
          )}
          {notes.length === 0 && <p className="text-sm text-muted-foreground">暂无随包发布说明。</p>}
          {notes.map(note => (
            <details key={`${request?.version ?? ''}:${note.version}`} open={selected === note} className="rounded-md border border-border p-3">
              <summary className="cursor-pointer text-sm font-medium">v{note.version}</summary>
              <div className="mt-3 border-t border-border pt-3">
                <ReleaseNotesBody markdown={note.markdown} compact />
              </div>
            </details>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  )
}
