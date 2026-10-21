import { MorphError } from './errors';

/** Declarative option description. The renderer builds its controls from these. */
interface BaseSpec {
  key: string;
  label: string;
  help?: string;
  /** Only show / apply this option when another option has one of these values. */
  visibleWhen?: { key: string; equals: ReadonlyArray<string | number | boolean> };
}

export interface RangeSpec extends BaseSpec {
  type: 'range';
  min: number;
  max: number;
  step: number;
  default: number;
  unit?: string;
}
export interface NumberSpec extends BaseSpec {
  type: 'number';
  min: number;
  max: number;
  /** `null` means "not set". */
  default: number | null;
  unit?: string;
  placeholder?: string;
}
export interface SelectSpec extends BaseSpec {
  type: 'select';
  choices: ReadonlyArray<{ value: string; label: string; description?: string }>;
  default: string;
}
export interface BooleanSpec extends BaseSpec {
  type: 'boolean';
  default: boolean;
}
export interface ColorSpec extends BaseSpec {
  type: 'color';
  default: string;
}
export interface TextSpec extends BaseSpec {
  type: 'text';
  default: string;
  maxLength: number;
  placeholder?: string;
  /** Must match when non-empty. */
  pattern?: string;
  patternHint?: string;
}

export type OptionSpec = RangeSpec | NumberSpec | SelectSpec | BooleanSpec | ColorSpec | TextSpec;
export type OptionValue = string | number | boolean | null;
export type OptionValues = Record<string, OptionValue>;

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

function invalid(spec: OptionSpec, why: string): never {
  throw new MorphError('INVALID_OPTIONS', `Invalid value for "${spec.label}": ${why}`);
}

function normalizeOne(spec: OptionSpec, raw: unknown): OptionValue {
  switch (spec.type) {
    case 'range': {
      if (typeof raw !== 'number' || !Number.isFinite(raw)) return invalid(spec, 'expected a number');
      if (raw < spec.min || raw > spec.max) return invalid(spec, `must be between ${spec.min} and ${spec.max}`);
      return Math.round(raw / spec.step) * spec.step;
    }
    case 'number': {
      if (raw === null || raw === '') return null;
      if (typeof raw !== 'number' || !Number.isFinite(raw)) return invalid(spec, 'expected a number');
      if (!Number.isInteger(raw)) return invalid(spec, 'expected a whole number');
      if (raw < spec.min || raw > spec.max) return invalid(spec, `must be between ${spec.min} and ${spec.max}`);
      return raw;
    }
    case 'select': {
      if (typeof raw !== 'string' || !spec.choices.some((c) => c.value === raw)) return invalid(spec, 'not an allowed choice');
      return raw;
    }
    case 'boolean': {
      if (typeof raw !== 'boolean') return invalid(spec, 'expected true or false');
      return raw;
    }
    case 'color': {
      if (typeof raw !== 'string' || !HEX_COLOR.test(raw)) return invalid(spec, 'expected a colour like #ffffff');
      return raw.toLowerCase();
    }
    case 'text': {
      if (typeof raw !== 'string') return invalid(spec, 'expected text');
      const value = raw.trim();
      if (value.length > spec.maxLength) return invalid(spec, `at most ${spec.maxLength} characters`);
      if (value !== '' && spec.pattern && !new RegExp(spec.pattern).test(value)) {
        return invalid(spec, spec.patternHint ?? 'unexpected format');
      }
      return value;
    }
  }
}

/** True when the spec's `visibleWhen` condition holds for the given (already normalized) values. */
export function isOptionActive(spec: OptionSpec, values: OptionValues): boolean {
  if (!spec.visibleWhen) return true;
  const current = values[spec.visibleWhen.key];
  return current !== undefined && current !== null && spec.visibleWhen.equals.includes(current);
}

/**
 * Validates user-supplied options against the specs. Unknown keys are ignored (a batch may mix
 * file types that support different options); missing keys fall back to defaults; invalid values throw.
 */
export function normalizeOptions(specs: readonly OptionSpec[], raw: Record<string, unknown> | undefined): OptionValues {
  const out: OptionValues = {};
  for (const spec of specs) {
    const supplied = raw !== undefined && Object.prototype.hasOwnProperty.call(raw, spec.key) ? raw[spec.key] : undefined;
    out[spec.key] = supplied === undefined ? spec.default : normalizeOne(spec, supplied);
  }
  return out;
}

export function defaultOptions(specs: readonly OptionSpec[]): OptionValues {
  const out: OptionValues = {};
  for (const spec of specs) out[spec.key] = spec.default;
  return out;
}

// Typed accessors keep engines free of casts.
export function optNumber(values: OptionValues, key: string): number {
  const v = values[key];
  if (typeof v !== 'number') throw new MorphError('INVALID_OPTIONS', `Option "${key}" must be a number.`);
  return v;
}
export function optNumberOrNull(values: OptionValues, key: string): number | null {
  const v = values[key];
  return typeof v === 'number' ? v : null;
}
export function optString(values: OptionValues, key: string): string {
  const v = values[key];
  if (typeof v !== 'string') throw new MorphError('INVALID_OPTIONS', `Option "${key}" must be text.`);
  return v;
}
export function optBoolean(values: OptionValues, key: string): boolean {
  const v = values[key];
  if (typeof v !== 'boolean') throw new MorphError('INVALID_OPTIONS', `Option "${key}" must be true or false.`);
  return v;
}
