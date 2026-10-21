import { type ButtonHTMLAttributes, type ReactNode, useId } from 'react';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';

const VARIANTS: Record<Variant, string> = {
  primary: 'bg-accent text-accent-ink font-semibold hover:brightness-110 disabled:bg-raised disabled:text-faint disabled:brightness-100',
  secondary: 'bg-raised text-ink border border-line hover:bg-hover disabled:text-faint',
  ghost: 'text-muted hover:text-ink hover:bg-raised disabled:text-faint',
  danger: 'bg-raised text-bad border border-line hover:bg-hover',
};

export function Button({ variant = 'secondary', className = '', ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return (
    <button
      type="button"
      {...props}
      className={`no-drag inline-flex h-8 items-center justify-center gap-1.5 rounded-lg px-3 text-[13px] transition-colors disabled:cursor-not-allowed ${VARIANTS[variant]} ${className}`}
    />
  );
}

export function IconButton({ label, className = '', children, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      {...props}
      className={`no-drag inline-flex size-8 items-center justify-center rounded-lg text-muted transition-colors hover:bg-raised hover:text-ink disabled:text-faint ${className}`}
    >
      {children}
    </button>
  );
}

export function Switch({ checked, onChange, label, description }: { checked: boolean; onChange: (value: boolean) => void; label: string; description?: string }) {
  const id = useId();
  return (
    <div className="no-drag flex items-start justify-between gap-4 py-2">
      <div className="min-w-0">
        <label htmlFor={id} className="block cursor-pointer text-[13px] text-ink">
          {label}
        </label>
        {description && <p className="mt-0.5 text-xs text-muted">{description}</p>}
      </div>
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={`relative mt-0.5 h-5 w-9 shrink-0 rounded-full border transition-colors ${checked ? 'border-accent bg-accent' : 'border-line-strong bg-raised'}`}
      >
        <span className={`absolute top-0.5 size-3.5 rounded-full transition-all ${checked ? 'left-[18px] bg-accent-ink' : 'left-0.5 bg-muted'}`} />
      </button>
    </div>
  );
}

export function Section({ title, children, description }: { title: string; description?: string; children: ReactNode }) {
  return (
    <section className="py-3">
      <h2 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-faint">{title}</h2>
      {description && <p className="mt-1 text-xs text-muted">{description}</p>}
      <div className="mt-2">{children}</div>
    </section>
  );
}

export function Spinner({ className = '' }: { className?: string }) {
  return <span aria-hidden className={`inline-block size-3.5 animate-spin rounded-full border-2 border-line-strong border-t-accent ${className}`} />;
}

export function Notice({ tone, children }: { tone: 'info' | 'warn' | 'bad' | 'ok'; children: ReactNode }) {
  const tones = {
    info: 'border-line text-muted',
    warn: 'border-warn/30 bg-warn/5 text-warn',
    bad: 'border-bad/30 bg-bad/5 text-bad',
    ok: 'border-ok/30 bg-ok/5 text-ok',
  };
  return (
    <div role={tone === 'bad' ? 'alert' : 'status'} className={`rounded-lg border px-3 py-2 text-xs leading-relaxed ${tones[tone]}`}>
      {children}
    </div>
  );
}
