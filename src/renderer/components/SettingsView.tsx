import { FolderOpen } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { Settings } from '../../shared/settings';
import type { AppInfo, ShortcutStatus } from '../../shared/types';
import { getApi } from '../lib/api';
import { Diagnostics } from './Diagnostics';
import { ShortcutRecorder } from './ShortcutRecorder';
import { Button, Section, Switch } from './ui';

interface Props {
  settings: Settings | null;
  onSettings: (settings: Settings) => void;
  shortcut: ShortcutStatus | null;
  onShortcut: (status: ShortcutStatus) => void;
}

function QualitySlider({ label, value, onCommit }: { label: string; value: number; onCommit: (v: number) => void }) {
  const [local, setLocal] = useState(value);
  const [seen, setSeen] = useState(value);
  if (seen !== value) {
    // Adjust state during render when the saved value changes from outside (documented React pattern).
    setSeen(value);
    setLocal(value);
  }
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  return (
    <div className="no-drag">
      <div className="flex justify-between">
        <label className="text-[13px] text-ink" htmlFor={`q-${label}`}>
          {label}
        </label>
        <output className="tabular-nums text-xs text-muted">{local}</output>
      </div>
      <input
        id={`q-${label}`}
        type="range"
        min={1}
        max={100}
        value={local}
        className="mt-1.5 w-full"
        onChange={(e) => {
          const v = Number(e.target.value);
          setLocal(v);
          clearTimeout(timer.current);
          timer.current = setTimeout(() => onCommit(v), 250);
        }}
      />
    </div>
  );
}

export function SettingsView({ settings, onSettings, shortcut, onShortcut }: Props) {
  const api = getApi();
  const [info, setInfo] = useState<AppInfo | null>(null);
  useEffect(() => void api.getAppInfo().then(setInfo), [api]);

  if (!settings) return <p className="px-4 pb-4 text-xs text-muted">Loading…</p>;

  const update = async (patch: Parameters<typeof api.updateSettings>[0]) => onSettings(await api.updateSettings(patch));

  return (
    <div className="divide-y divide-line px-4 pb-4">
      <Section title="Shortcut" description="Opens the Morph popup from anywhere in Windows.">
        <ShortcutRecorder status={shortcut} onStatus={onShortcut} />
      </Section>

      <Section title="Saving files" description="Converted files are saved next to the original unless you choose a folder.">
        <div className="no-drag space-y-3">
          <div role="radiogroup" aria-label="Output naming" className="space-y-1.5">
            {(
              [
                ['same-name', 'Keep the name', 'logo.png → logo.webp'],
                ['suffix', 'Add a suffix', 'logo.png → logo_converted.webp'],
              ] as const
            ).map(([value, label, example]) => (
              <label key={value} className="flex cursor-pointer items-center gap-2.5 text-[13px]">
                <input type="radio" name="naming" className="accent-[var(--color-accent)]" checked={settings.outputNaming === value} onChange={() => void update({ outputNaming: value })} />
                <span className="text-ink">{label}</span>
                <span className="text-xs text-muted">{example}</span>
              </label>
            ))}
          </div>
          {settings.outputNaming === 'suffix' && (
            <div>
              <label htmlFor="suffix" className="text-[13px] text-ink">
                Suffix
              </label>
              <input
                id="suffix"
                type="text"
                maxLength={32}
                spellCheck={false}
                defaultValue={settings.outputSuffix}
                onBlur={(e) => void update({ outputSuffix: e.target.value }).catch(() => undefined)}
                className="mt-1.5 block h-8 w-48 rounded-lg border border-line bg-raised px-2.5 text-[13px] focus:border-accent focus:outline-none"
              />
            </div>
          )}
          <div>
            <p className="text-[13px] text-ink">Output folder</p>
            <p className="mt-0.5 truncate text-xs text-muted select-text" title={settings.outputDirectory ?? undefined}>
              {settings.outputDirectory ?? 'Next to the original file (default)'}
            </p>
            <div className="mt-2 flex gap-2">
              <Button onClick={() => void api.pickOutputDirectory().then((s) => s && onSettings(s))}>
                <FolderOpen size={14} aria-hidden /> Choose folder…
              </Button>
              {settings.outputDirectory && (
                <Button variant="ghost" onClick={() => void update({ outputDirectory: null })}>
                  Use original folder
                </Button>
              )}
            </div>
          </div>
          <p className="text-xs text-muted">Morph never overwrites a file. If the name is taken it adds a number, like <span className="text-ink">logo (1).webp</span>.</p>
        </div>
      </Section>

      <Section title="Image quality defaults" description="Starting values for lossy formats. You can still change them for each conversion.">
        <div className="grid gap-3 min-[520px]:grid-cols-3">
          <QualitySlider label="JPG" value={settings.imageQuality.jpg} onCommit={(jpg) => void update({ imageQuality: { jpg } })} />
          <QualitySlider label="WebP" value={settings.imageQuality.webp} onCommit={(webp) => void update({ imageQuality: { webp } })} />
          <QualitySlider label="AVIF" value={settings.imageQuality.avif} onCommit={(avif) => void update({ imageQuality: { avif } })} />
        </div>
      </Section>

      <Section title="Behaviour">
        <Switch label="Take keyboard focus when opened" description="Off by default so the popup never interrupts typing in the app you are using. Press the shortcut again, or click the popup, to use the keyboard." checked={settings.focusOnOpen} onChange={(v) => void update({ focusOnOpen: v })} />
        <Switch label="Hide when I click elsewhere" checked={settings.hideOnBlur} onChange={(v) => void update({ hideOnBlur: v })} />
        <Switch label="Notify when conversions finish" description="Shown only when the popup is not in front." checked={settings.notifications} onChange={(v) => void update({ notifications: v })} />
        <Switch label="Start Morph when I sign in to Windows" description="Runs quietly in the tray. Off by default." checked={settings.launchAtLogin} onChange={(v) => void update({ launchAtLogin: v })} />
      </Section>

      <Section title="Tools" description="Helper programs Morph uses. Nothing is downloaded or run without you knowing.">
        <Diagnostics />
      </Section>

      <Section title="About &amp; privacy">
        <div className="space-y-2 text-xs text-muted">
          <p>
            Morph {info?.version ?? ''} · Electron {info?.electron ?? ''} · MIT licence. Everything happens on this computer: no accounts, no uploads, no telemetry, no network access.
          </p>
          <Button onClick={() => void api.openLogs()}>
            <FolderOpen size={14} aria-hidden /> Open log folder
          </Button>
        </div>
      </Section>
    </div>
  );
}
