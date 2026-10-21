import { File, FileImage, FileText, Film, Music, X } from 'lucide-react';
import type { InspectedFile } from '../../shared/types';
import { formatBytes, formatDuration, middleEllipsis, plural } from '../lib/format';
import { IconButton } from './ui';

const ICONS = { image: FileImage, document: FileText, audio: Music, video: Film } as const;

function detailLine(file: InspectedFile): string {
  const parts: string[] = [file.formatLabel, formatBytes(file.size)];
  const d = file.details;
  if (d.width && d.height) parts.push(`${d.width} × ${d.height}`);
  if (d.pages && file.category !== 'image') parts.push(plural(d.pages, 'page'));
  if (d.animated && d.pages) parts.push(`animated, ${plural(d.pages, 'frame')}`);
  if (d.durationSec) parts.push(formatDuration(d.durationSec));
  return parts.join(' · ');
}

export function FileCard({ file, onRemove, removable }: { file: InspectedFile; onRemove: () => void; removable: boolean }) {
  const Icon = ICONS[file.category] ?? File;
  return (
    <li className="no-drag flex items-center gap-3 rounded-xl border border-line bg-surface p-2.5 animate-fade-in">
      {file.preview ? (
        <img src={file.preview} alt={`Preview of ${file.name}`} className="size-12 shrink-0 rounded-lg bg-raised object-contain" draggable={false} />
      ) : (
        <div className="grid size-12 shrink-0 place-items-center rounded-lg bg-raised text-accent">
          <Icon size={22} aria-hidden />
        </div>
      )}
      <div className="min-w-0 flex-1">
        <p className="truncate text-[13px] font-medium text-ink" title={file.path}>
          {middleEllipsis(file.name, 46)}
        </p>
        <p className="truncate text-xs text-muted">{detailLine(file)}</p>
        {file.notes.map((note) => (
          <p key={note} className="mt-0.5 text-xs text-warn">
            {note}
          </p>
        ))}
      </div>
      {removable && (
        <IconButton label={`Remove ${file.name}`} onClick={onRemove}>
          <X size={15} aria-hidden />
        </IconButton>
      )}
    </li>
  );
}
