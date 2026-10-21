import { useId } from 'react';
import { isOptionActive, type OptionSpec, type OptionValue, type OptionValues } from '../../shared/options';

interface FieldProps {
  spec: OptionSpec;
  value: OptionValue | undefined;
  onChange: (value: OptionValue) => void;
}

const inputClass =
  'no-drag h-8 rounded-lg border border-line bg-raised px-2.5 text-[13px] text-ink placeholder:text-faint hover:border-line-strong focus:border-accent focus:outline-none';

function Field({ spec, value, onChange }: FieldProps) {
  const id = useId();
  const helpId = `${id}-help`;
  const help = spec.help ? (
    <p id={helpId} className="mt-1 text-xs text-muted">
      {spec.help}
    </p>
  ) : null;

  switch (spec.type) {
    case 'range': {
      const current = typeof value === 'number' ? value : spec.default;
      return (
        <div>
          <div className="flex items-center justify-between">
            <label htmlFor={id} className="text-[13px] text-ink">
              {spec.label}
            </label>
            <output htmlFor={id} className="tabular-nums text-xs text-muted">
              {current}
              {spec.unit ?? ''}
            </output>
          </div>
          <input
            id={id}
            type="range"
            className="no-drag mt-1.5 w-full"
            min={spec.min}
            max={spec.max}
            step={spec.step}
            value={current}
            aria-describedby={spec.help ? helpId : undefined}
            onChange={(e) => onChange(Number(e.target.value))}
          />
          {help}
        </div>
      );
    }
    case 'number':
      return (
        <div>
          <label htmlFor={id} className="text-[13px] text-ink">
            {spec.label}
          </label>
          <div className="mt-1.5 flex items-center gap-2">
            <input
              id={id}
              type="number"
              inputMode="numeric"
              className={`${inputClass} w-28`}
              min={spec.min}
              max={spec.max}
              placeholder={spec.placeholder}
              value={typeof value === 'number' ? value : ''}
              aria-describedby={spec.help ? helpId : undefined}
              onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
            />
            {spec.unit && <span className="text-xs text-muted">{spec.unit}</span>}
          </div>
          {help}
        </div>
      );
    case 'select': {
      const current = typeof value === 'string' ? value : spec.default;
      const selected = spec.choices.find((c) => c.value === current);
      return (
        <div>
          <label htmlFor={id} className="text-[13px] text-ink">
            {spec.label}
          </label>
          <select id={id} className={`${inputClass} mt-1.5 block w-full`} value={current} aria-describedby={spec.help ? helpId : undefined} onChange={(e) => onChange(e.target.value)}>
            {spec.choices.map((choice) => (
              <option key={choice.value} value={choice.value}>
                {choice.label}
              </option>
            ))}
          </select>
          {selected?.description && <p className="mt-1 text-xs text-muted">{selected.description}</p>}
          {help}
        </div>
      );
    }
    case 'boolean': {
      const current = typeof value === 'boolean' ? value : spec.default;
      return (
        <div>
          <label className="no-drag flex cursor-pointer items-center gap-2.5 text-[13px] text-ink">
            <input id={id} type="checkbox" className="size-4 accent-[var(--color-accent)]" checked={current} aria-describedby={spec.help ? helpId : undefined} onChange={(e) => onChange(e.target.checked)} />
            {spec.label}
          </label>
          {help}
        </div>
      );
    }
    case 'color': {
      const current = typeof value === 'string' ? value : spec.default;
      return (
        <div>
          <label htmlFor={id} className="text-[13px] text-ink">
            {spec.label}
          </label>
          <div className="mt-1.5 flex items-center gap-2">
            <input id={id} type="color" className="no-drag size-8 cursor-pointer rounded-lg border border-line bg-raised p-0.5" value={current} aria-describedby={spec.help ? helpId : undefined} onChange={(e) => onChange(e.target.value)} />
            <span className="font-mono text-xs text-muted">{current}</span>
          </div>
          {help}
        </div>
      );
    }
    case 'text': {
      const current = typeof value === 'string' ? value : spec.default;
      return (
        <div>
          <label htmlFor={id} className="text-[13px] text-ink">
            {spec.label}
          </label>
          <input
            id={id}
            type="text"
            spellCheck={false}
            className={`${inputClass} mt-1.5 block w-full`}
            maxLength={spec.maxLength}
            placeholder={spec.placeholder}
            value={current}
            aria-describedby={spec.help ? helpId : undefined}
            onChange={(e) => onChange(e.target.value)}
          />
          {help}
        </div>
      );
    }
  }
}

export function OptionsPanel({ specs, values, onChange }: { specs: readonly OptionSpec[]; values: OptionValues; onChange: (key: string, value: OptionValue) => void }) {
  const visible = specs.filter((spec) => isOptionActive(spec, values));
  if (visible.length === 0) return null;
  return (
    <div className="grid gap-3.5 min-[520px]:grid-cols-2" role="group" aria-label="Conversion settings">
      {visible.map((spec) => (
        <div key={spec.key} className={spec.type === 'range' || spec.type === 'text' || spec.type === 'boolean' ? 'min-[520px]:col-span-2' : ''}>
          <Field spec={spec} value={values[spec.key]} onChange={(v) => onChange(spec.key, v)} />
        </div>
      ))}
    </div>
  );
}
