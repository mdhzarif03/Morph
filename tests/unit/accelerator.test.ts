import { describe, expect, it } from 'vitest';
import { acceleratorFromKeyEvent, DEFAULT_ACCELERATOR, validateAccelerator } from '../../src/shared/accelerator';

const ev = (over: Partial<Parameters<typeof acceleratorFromKeyEvent>[0]>) => ({ key: 'c', code: 'KeyC', ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...over });

describe('global shortcut validation', () => {
  it('uses Ctrl+Shift+C by default and accepts it', () => {
    expect(DEFAULT_ACCELERATOR).toBe('Ctrl+Shift+C');
    expect(validateAccelerator(DEFAULT_ACCELERATOR)).toMatchObject({ ok: true, normalized: 'Ctrl+Shift+C' });
  });

  it('refuses Shift+C and other bare or shift-only combinations that would break typing', () => {
    for (const bad of ['Shift+C', 'C', 'Shift+1', 'Space', 'Shift+Space']) {
      const result = validateAccelerator(bad);
      expect(result.ok, bad).toBe(false);
    }
    const shiftC = validateAccelerator('Shift+C');
    expect(shiftC.ok ? '' : shiftC.message).toMatch(/typing/);
  });

  it('refuses single Ctrl/Alt + letter (used by every application)', () => {
    expect(validateAccelerator('Ctrl+C').ok).toBe(false);
    expect(validateAccelerator('Alt+X').ok).toBe(false);
  });

  it('accepts sensible combinations and normalises order and aliases', () => {
    expect(validateAccelerator('shift+control+c')).toMatchObject({ ok: true, normalized: 'Ctrl+Shift+C' });
    expect(validateAccelerator('CommandOrControl+Alt+M')).toMatchObject({ ok: true, normalized: 'Ctrl+Alt+M' });
    expect(validateAccelerator('Win+Shift+S')).toMatchObject({ ok: true, normalized: 'Shift+Super+S' });
    expect(validateAccelerator('Ctrl+Shift+F9')).toMatchObject({ ok: true });
    expect(validateAccelerator('F15')).toMatchObject({ ok: true });
    expect(validateAccelerator('Ctrl+Alt+Up')).toMatchObject({ ok: true });
  });

  it('refuses Windows-reserved combinations, junk and malformed input', () => {
    expect(validateAccelerator('Ctrl+Alt+Delete').ok).toBe(false);
    expect(validateAccelerator('Alt+F4').ok).toBe(false);
    expect(validateAccelerator('').ok).toBe(false);
    expect(validateAccelerator('Ctrl+Shift').ok).toBe(false);
    expect(validateAccelerator('Ctrl+A+B').ok).toBe(false);
    expect(validateAccelerator('Ctrl+Shift+Banana').ok).toBe(false);
    expect(validateAccelerator('Ctrl++').ok).toBe(false); // Ctrl+Plus alone is a single-modifier shortcut
  });

  it('builds accelerators from key events and ignores modifier-only presses', () => {
    expect(acceleratorFromKeyEvent(ev({ ctrlKey: true, shiftKey: true }))).toBe('Ctrl+Shift+C');
    expect(acceleratorFromKeyEvent(ev({ key: 'Control', code: 'ControlLeft', ctrlKey: true }))).toBeNull();
    expect(acceleratorFromKeyEvent(ev({ key: '5', code: 'Digit5', altKey: true, ctrlKey: true }))).toBe('Ctrl+Alt+5');
    expect(acceleratorFromKeyEvent(ev({ key: 'ArrowUp', code: 'ArrowUp', ctrlKey: true, altKey: true }))).toBe('Ctrl+Alt+Up');
    expect(acceleratorFromKeyEvent(ev({ key: 'F12', code: 'F12', ctrlKey: true }))).toBe('Ctrl+F12');
  });
});
