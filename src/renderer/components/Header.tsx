import { Settings as SettingsIcon, X, ChevronLeft } from 'lucide-react';
import logoUrl from '../logo.svg';
import { IconButton } from './ui';

interface Props {
  view: 'home' | 'settings';
  shortcut: string | null;
  onSettings: () => void;
  onBack: () => void;
  onClose: () => void;
}

export function Header({ view, shortcut, onSettings, onBack, onClose }: Props) {
  return (
    <header className="drag flex items-center justify-between px-4 pb-2 pt-3">
      <div className="flex items-center gap-2.5">
        {view === 'settings' && (
          <IconButton label="Back" onClick={onBack}>
            <ChevronLeft size={17} aria-hidden />
          </IconButton>
        )}
        <img src={logoUrl} alt="" className="size-7" draggable={false} />
        <div className="leading-tight">
          <h1 className="text-sm font-semibold tracking-tight text-ink">{view === 'settings' ? 'Settings' : 'Morph'}</h1>
          <p className="text-[11px] text-faint">{view === 'settings' ? 'Morph · Files, transformed.' : 'Files, transformed.'}</p>
        </div>
      </div>
      <div className="flex items-center gap-1">
        {view === 'home' && shortcut && (
          <kbd className="mr-1 rounded-md border border-line bg-surface px-1.5 py-0.5 font-sans text-[11px] text-muted" title="Global shortcut">
            {shortcut.split('+').join(' + ')}
          </kbd>
        )}
        {view === 'home' && (
          <IconButton label="Settings" onClick={onSettings}>
            <SettingsIcon size={16} aria-hidden />
          </IconButton>
        )}
        <IconButton label="Close (Esc)" onClick={onClose}>
          <X size={16} aria-hidden />
        </IconButton>
      </div>
    </header>
  );
}
