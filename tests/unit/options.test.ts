import { describe, expect, it } from 'vitest';
import { defaultOptions, isOptionActive, normalizeOptions, type OptionSpec } from '../../src/shared/options';

const specs: OptionSpec[] = [
  { key: 'quality', type: 'range', label: 'Quality', min: 1, max: 100, step: 1, default: 80 },
  { key: 'width', type: 'number', label: 'Width', min: 1, max: 16384, default: null },
  { key: 'mode', type: 'select', label: 'Mode', default: 'a', choices: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }] },
  { key: 'flag', type: 'boolean', label: 'Flag', default: false },
  { key: 'bg', type: 'color', label: 'Background', default: '#ffffff' },
  { key: 'pages', type: 'text', label: 'Pages', default: '', maxLength: 10, pattern: '^[0-9,-]+$', patternHint: 'digits only' },
  { key: 'extra', type: 'range', label: 'Extra', min: 0, max: 10, step: 1, default: 5, visibleWhen: { key: 'flag', equals: [true] } },
];

describe('option validation', () => {
  it('fills defaults and ignores unknown keys', () => {
    const out = normalizeOptions(specs, { somethingElse: 1 });
    expect(out).toEqual({ quality: 80, width: null, mode: 'a', flag: false, bg: '#ffffff', pages: '', extra: 5 });
    expect(defaultOptions(specs)).toEqual(out);
  });

  it('accepts valid values and normalises them', () => {
    const out = normalizeOptions(specs, { quality: 90, width: 640, mode: 'b', flag: true, bg: '#AABBCC', pages: ' 1-3 ' });
    expect(out).toMatchObject({ quality: 90, width: 640, mode: 'b', flag: true, bg: '#aabbcc', pages: '1-3' });
  });

  it.each([
    [{ quality: 0 }, /between 1 and 100/],
    [{ quality: 101 }, /between 1 and 100/],
    [{ quality: '90' }, /expected a number/],
    [{ quality: Number.NaN }, /expected a number/],
    [{ width: 1.5 }, /whole number/],
    [{ width: 99999 }, /between/],
    [{ mode: 'c' }, /allowed choice/],
    [{ flag: 'yes' }, /true or false/],
    [{ bg: 'red' }, /colour/],
    [{ bg: '#12345' }, /colour/],
    [{ pages: 'a;rm -rf' }, /digits only/],
    [{ pages: '1,2,3,4,5,6,7,8' }, /at most 10/],
  ])('rejects invalid input %j', (input, message) => {
    expect(() => normalizeOptions(specs, input)).toThrowError(message);
  });

  it('does not let prototype keys leak in', () => {
    const out = normalizeOptions(specs, JSON.parse('{"__proto__": {"polluted": true}, "constructor": 1}') as Record<string, unknown>);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.keys(out)).not.toContain('constructor');
  });

  it('evaluates conditional visibility', () => {
    const extra = specs[6] as OptionSpec;
    expect(isOptionActive(extra, { flag: false })).toBe(false);
    expect(isOptionActive(extra, { flag: true })).toBe(true);
  });
});
