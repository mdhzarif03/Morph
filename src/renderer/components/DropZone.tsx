import { FolderOpen, Upload } from 'lucide-react';
import { Button, Spinner } from './ui';

interface Props {
  dragging: boolean;
  busy: boolean;
  compact?: boolean;
  onBrowse: () => void;
}

export function DropZone({ dragging, busy, compact = false, onBrowse }: Props) {
  return (
    <div
      className={`no-drag rounded-xl border border-dashed text-center transition-colors ${compact ? 'px-4 py-3' : 'px-6 py-9'} ${
        dragging ? 'border-accent bg-accent/10' : 'border-line-strong bg-surface'
      }`}
    >
      {compact ? (
        <div className="flex items-center justify-between gap-3">
          <p className="text-xs text-muted">{dragging ? 'Drop to add' : 'Drop more files here'}</p>
          <Button onClick={onBrowse} disabled={busy} aria-label="Browse for more files">
            <FolderOpen size={14} aria-hidden /> Browse
          </Button>
        </div>
      ) : (
        <>
          <div className={`mx-auto mb-3 grid size-11 place-items-center rounded-full transition-colors ${dragging ? 'bg-accent text-accent-ink' : 'bg-raised text-accent'}`}>
            {busy ? <Spinner className="size-5" /> : <Upload size={20} aria-hidden />}
          </div>
          <p className="text-sm font-medium text-ink">{busy ? 'Reading files…' : dragging ? 'Drop to convert' : 'Drop a file here'}</p>
          <p className="mt-1 text-xs text-muted">Images, PDFs, documents, audio and video — converted on this computer.</p>
          <Button className="mt-4" onClick={onBrowse} disabled={busy}>
            <FolderOpen size={14} aria-hidden /> Browse files
          </Button>
        </>
      )}
    </div>
  );
}
