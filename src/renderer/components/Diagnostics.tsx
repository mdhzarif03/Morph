import { CircleAlert, CircleCheck, RefreshCw } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { ToolId, ToolchainSnapshot, ToolStatus } from '../../shared/types';
import { getApi } from '../lib/api';
import { Button, Notice, Spinner } from './ui';

const SOURCE_LABEL: Record<NonNullable<ToolStatus['source']>, string> = {
  settings: 'chosen by you',
  bundled: 'bundled with Morph',
  npm: 'installed with Morph',
  'system-path': 'found on PATH',
  'known-location': 'found in a standard location',
};

function ToolRow({ tool, onPick, onClear }: { tool: ToolStatus; onPick: () => void; onClear: () => void }) {
  return (
    <li className="rounded-lg border border-line bg-surface p-2.5">
      <div className="flex items-start gap-2">
        {tool.found ? <CircleCheck size={15} className="mt-0.5 shrink-0 text-ok" aria-hidden /> : <CircleAlert size={15} className="mt-0.5 shrink-0 text-warn" aria-hidden />}
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-medium text-ink">
            {tool.label}
            {tool.version && <span className="ml-1.5 font-normal text-muted">{tool.version}</span>}
            <span className="sr-only">{tool.found ? ' — available' : ' — missing'}</span>
          </p>
          <p className="text-xs text-muted">{tool.neededFor}</p>
          {tool.found && tool.path && (
            <p className="mt-0.5 truncate text-xs text-faint select-text" title={tool.path}>
              {tool.path} · {tool.source ? SOURCE_LABEL[tool.source] : ''}
            </p>
          )}
          {!tool.found && <p className="mt-1 text-xs text-warn">{tool.installHint}</p>}
          {tool.encoders && tool.encoders.length > 0 && <p className="mt-0.5 text-xs text-faint">Encoders: {tool.encoders.join(', ')}</p>}
        </div>
        <div className="flex shrink-0 gap-1">
          <Button onClick={onPick}>Locate…</Button>
          {tool.source === 'settings' && (
            <Button variant="ghost" onClick={onClear}>
              Reset
            </Button>
          )}
        </div>
      </div>
    </li>
  );
}

export function Diagnostics() {
  const api = getApi();
  const [snapshot, setSnapshot] = useState<ToolchainSnapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void api.getDiagnostics().then(setSnapshot);
  }, [api]);

  const run = async (action: () => Promise<ToolchainSnapshot | null>) => {
    setBusy(true);
    setError(null);
    try {
      const next = await action();
      if (next) setSnapshot(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'That did not work.');
    } finally {
      setBusy(false);
    }
  };

  if (!snapshot) return <p className="text-xs text-muted">Checking tools…</p>;
  const order: ToolId[] = ['ffmpeg', 'ffprobe', 'pdftoppm', 'pdfinfo', 'soffice'];
  return (
    <div className="space-y-2.5">
      <p className="text-xs text-muted">Images work without any extra tools. Everything else needs the helper programs below.</p>
      <ul className="space-y-2">
        {order.map((id) => (
          <ToolRow key={id} tool={snapshot.tools[id]} onPick={() => void run(() => api.pickToolPath(id))} onClear={() => void run(() => api.clearToolPath(id))} />
        ))}
      </ul>
      {error && <Notice tone="bad">{error}</Notice>}
      <Button onClick={() => void run(() => api.getDiagnostics(true))} disabled={busy}>
        {busy ? <Spinner /> : <RefreshCw size={14} aria-hidden />} Check again
      </Button>
    </div>
  );
}
