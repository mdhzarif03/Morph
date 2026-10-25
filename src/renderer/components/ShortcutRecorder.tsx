import { Keyboard } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { acceleratorFromKeyEvent, validateAccelerator, DEFAULT_ACCELERATOR } from '../../shared/accelerator';
import type { ShortcutStatus } from '../../shared/types';
import { getApi } from '../lib/api';
import { Button, Notice } from './ui';

const pretty = (accelerator: string) => accelerator.split('+').join(' + ');

export function ShortcutRecorder({ status, onStatus }: { status: ShortcutStatus | null; onStatus: (s: ShortcutStatus) => void }) {
  const api = getApi();
  const [recording, setRecording] = useState(false);
  const [message, setMessage] = useState<{ tone: 'ok' | 'bad' | 'info'; text: string } | null>(null);
  const [held, setHeld] = useState('');
  const [typed, setTyped] = useState('');
  const buttonRef = useRef<HTMLButtonElement>(null);

  const apply = async (accelerator: string) => {
    const check = validateAccelerator(accelerator);
    if (!check.ok) {
      setMessage({ tone: 'bad', text: check.message });
      return;
    }
    try {
      const result = await api.setShortcut(check.normalized);
      onStatus(result.status);
      setMessage(result.ok ? { tone: 'ok', text: `Shortcut set to ${pretty(result.status.accelerator)}.` } : { tone: 'bad', text: result.message });
    } catch (error) {
      setMessage({ tone: 'bad', text: error instanceof Error ? error.message : 'The shortcut could not be changed.' });
    }
  };

  useEffect(() => {
    if (!recording) return;
    // Pressing Ctrl+Shift or Alt+Shift can make Windows flash its language switcher and take focus for a
    // moment. Tell the main process not to hide the popup while a shortcut is being recorded.
    void api.setShortcutCapture(true).catch(() => undefined);
    const stopOnOutsideClick = (e: MouseEvent) => {
      if (buttonRef.current && e.target instanceof Node && !buttonRef.current.contains(e.target)) {
        setRecording(false);
        setHeld('');
      }
    };
    window.addEventListener('mousedown', stopOnOutsideClick, true);
    const onKeyDown = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') {
        setRecording(false);
        setHeld('');
        setMessage(null);
        return;
      }
      const accelerator = acceleratorFromKeyEvent(e);
      if (accelerator === null) {
        const mods = [e.ctrlKey && 'Ctrl', e.altKey && 'Alt', e.shiftKey && 'Shift', e.metaKey && 'Win'].filter(Boolean).join(' + ');
        setHeld(mods);
        return;
      }
      setRecording(false);
      setHeld('');
      void apply(accelerator);
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('mousedown', stopOnOutsideClick, true);
      void api.setShortcutCapture(false).catch(() => undefined);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recording]);

  return (
    <div className="no-drag">
      <div className="flex items-center gap-2">
        <button
          ref={buttonRef}
          type="button"
          onClick={() => {
            setRecording((value) => !value);
            setHeld('');
            setMessage(null);
          }}
          aria-label={recording ? 'Recording shortcut. Press the new key combination, or Escape to cancel.' : `Global shortcut: ${status ? pretty(status.accelerator) : ''}. Activate to change.`}
          className={`flex h-9 min-w-52 items-center gap-2 rounded-lg border px-3 text-[13px] transition-colors ${recording ? 'border-accent bg-accent/10 text-accent' : 'border-line bg-raised text-ink hover:border-line-strong'}`}
        >
          <Keyboard size={15} aria-hidden />
          {recording ? (held ? `${held} + …` : 'Press the new shortcut…') : status ? pretty(status.accelerator) : '…'}
        </button>
        {status && status.accelerator !== DEFAULT_ACCELERATOR.replace(/\s/g, '') && !recording && (
          <Button variant="ghost" onClick={() => void apply(DEFAULT_ACCELERATOR)}>
            Reset
          </Button>
        )}
      </div>
      <div className="mt-2 space-y-2" aria-live="polite">
        {status && !status.registered && <Notice tone="warn">This shortcut is not active. {status.problem ?? ''}</Notice>}
        {message && <Notice tone={message.tone}>{message.text}</Notice>}
        <form
          className="flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (typed.trim() !== '') void apply(typed);
          }}
        >
          <label htmlFor="shortcut-typed" className="text-xs text-muted">
            Or type it
          </label>
          <input
            id="shortcut-typed"
            type="text"
            value={typed}
            placeholder="Ctrl+Alt+M"
            maxLength={40}
            onChange={(e) => setTyped(e.target.value)}
            className="h-8 w-40 rounded-lg border border-line bg-raised px-2 text-[13px] text-ink placeholder:text-faint"
          />
          <Button type="submit" disabled={typed.trim() === ''}>
            Set
          </Button>
        </form>
        <p className="text-xs text-muted">
          Use Ctrl, Alt or the Windows key with another key. Plain keys such as <kbd className="font-sans">Shift + C</kbd> are refused because they would stop you typing that letter in every other app.
        </p>
      </div>
    </div>
  );
}
