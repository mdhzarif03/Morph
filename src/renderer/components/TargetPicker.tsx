import { useRef } from 'react';
import type { FormatId } from '../../shared/formats';
import type { TargetDescriptor } from '../../shared/types';

interface Props {
  targets: TargetDescriptor[];
  selected: FormatId | null;
  onSelect: (format: FormatId) => void;
}

/** Radio-group of output formats with roving focus: arrow keys move between available formats. */
export function TargetPicker({ targets, selected, onSelect }: Props) {
  const refs = useRef(new Map<FormatId, HTMLButtonElement>());
  const available = targets.filter((t) => t.available);
  const unavailable = targets.filter((t) => !t.available);

  const move = (from: FormatId, delta: number) => {
    const index = available.findIndex((t) => t.format === from);
    const next = available[(index + delta + available.length) % available.length];
    if (next) {
      onSelect(next.format);
      refs.current.get(next.format)?.focus();
    }
  };

  const focusable = selected ?? available[0]?.format;

  return (
    <div>
      <div role="radiogroup" aria-label="Convert to" className="no-drag flex flex-wrap gap-1.5">
        {available.map((target) => {
          const isSelected = target.format === selected;
          return (
            <button
              key={target.format}
              ref={(el) => {
                if (el) refs.current.set(target.format, el);
                else refs.current.delete(target.format);
              }}
              type="button"
              role="radio"
              aria-checked={isSelected}
              tabIndex={target.format === focusable ? 0 : -1}
              title={target.description}
              onClick={() => onSelect(target.format)}
              onKeyDown={(e) => {
                if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
                  e.preventDefault();
                  move(target.format, 1);
                } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
                  e.preventDefault();
                  move(target.format, -1);
                }
              }}
              className={`h-8 rounded-lg border px-3 text-[13px] transition-colors ${
                isSelected ? 'border-accent bg-accent/15 font-semibold text-accent' : 'border-line bg-raised text-ink hover:border-line-strong hover:bg-hover'
              }`}
            >
              {target.label}
            </button>
          );
        })}
      </div>
      {available.length === 0 && <p className="mt-1 text-xs text-muted">No conversions are available for this selection.</p>}
      {unavailable.length > 0 && (
        <details className="no-drag mt-2.5 text-xs text-muted">
          <summary className="cursor-pointer select-none hover:text-ink">{unavailable.length} more unavailable on this computer</summary>
          <ul className="mt-1.5 space-y-1">
            {unavailable.map((target) => (
              <li key={target.format}>
                <span className="text-ink">{target.label}</span> — {target.unavailableReason}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
