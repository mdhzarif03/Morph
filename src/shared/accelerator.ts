/**
 * Global-shortcut ("accelerator") parsing and validation. Pure functions, shared by the main
 * process (authoritative) and the settings UI (instant feedback).
 *
 * Policy: a global shortcut is seen by *every* application, so combinations that would break
 * ordinary typing ("C", "Shift+C", "Ctrl+C") are refused with an explanation.
 */

export const DEFAULT_ACCELERATOR = 'Ctrl+Shift+C';

export type AcceleratorCheck =
  | { ok: true; normalized: string; display: string }
  | { ok: false; message: string };

const MODIFIER_ALIASES: Record<string, 'Ctrl' | 'Alt' | 'Shift' | 'Super'> = {
  ctrl: 'Ctrl',
  control: 'Ctrl',
  commandorcontrol: 'Ctrl',
  cmdorctrl: 'Ctrl',
  alt: 'Alt',
  option: 'Alt',
  shift: 'Shift',
  super: 'Super',
  meta: 'Super',
  win: 'Super',
  windows: 'Super',
  cmd: 'Super',
  command: 'Super',
};

const MODIFIER_ORDER = ['Ctrl', 'Alt', 'Shift', 'Super'] as const;

const NAMED_KEYS: Record<string, string> = {
  space: 'Space',
  tab: 'Tab',
  enter: 'Enter',
  return: 'Enter',
  backspace: 'Backspace',
  delete: 'Delete',
  del: 'Delete',
  insert: 'Insert',
  home: 'Home',
  end: 'End',
  pageup: 'PageUp',
  pagedown: 'PageDown',
  up: 'Up',
  down: 'Down',
  left: 'Left',
  right: 'Right',
  esc: 'Escape',
  escape: 'Escape',
  plus: 'Plus',
};

const PUNCTUATION = new Set(['-', '=', '[', ']', ';', "'", ',', '.', '/', '\\', '`']);

/** Combinations the operating system owns. Registration is pointless or harmful. */
const OS_RESERVED = new Set([
  'Ctrl+Alt+Delete',
  'Alt+F4',
  'Alt+Tab',
  'Alt+Escape',
  'Ctrl+Escape',
  'Ctrl+Shift+Escape',
  'Super+L',
  'Super+D',
  'Super+Tab',
]);

function canonicalKey(raw: string): string | null {
  const lower = raw.toLowerCase();
  if (/^[a-z]$/.test(lower)) return lower.toUpperCase();
  if (/^[0-9]$/.test(lower)) return lower;
  const fn = /^f([1-9]|1[0-9]|2[0-4])$/.exec(lower);
  if (fn) return `F${fn[1]}`;
  const named = NAMED_KEYS[lower];
  if (named) return named;
  if (PUNCTUATION.has(raw)) return raw;
  return null;
}

function isFunctionKey(key: string): boolean {
  return /^F([1-9]|1[0-9]|2[0-4])$/.test(key);
}

export function validateAccelerator(input: string): AcceleratorCheck {
  const trimmed = input.trim();
  if (trimmed === '') return { ok: false, message: 'Press a key combination to set the shortcut.' };

  const parts = trimmed.split('+').map((p) => p.trim());
  // "Ctrl++" style: an empty trailing segment means the key is "+"
  if (trimmed.endsWith('++')) parts.splice(parts.length - 2, 2, 'Plus');
  if (parts.some((p) => p === '')) return { ok: false, message: 'That is not a valid key combination.' };

  const modifiers = new Set<(typeof MODIFIER_ORDER)[number]>();
  let key: string | null = null;

  for (const part of parts) {
    const mod = MODIFIER_ALIASES[part.toLowerCase()];
    if (mod) {
      modifiers.add(mod);
      continue;
    }
    if (key !== null) return { ok: false, message: 'Use exactly one non-modifier key (for example Ctrl+Shift+C).' };
    const canonical = canonicalKey(part);
    if (canonical === null) return { ok: false, message: `"${part}" cannot be used in a global shortcut.` };
    key = canonical;
  }

  if (key === null) return { ok: false, message: 'Add a key to go with the modifier keys.' };

  const ordered = MODIFIER_ORDER.filter((m) => modifiers.has(m));
  const normalized = [...ordered, key].join('+');

  const fn = isFunctionKey(key);
  const fnNumber = fn ? Number(key.slice(1)) : 0;
  const hasPrimaryModifier = modifiers.has('Ctrl') || modifiers.has('Alt') || modifiers.has('Super');

  if (modifiers.size === 0) {
    if (fn && fnNumber >= 13) return finish(normalized);
    return {
      ok: false,
      message: 'A global shortcut needs at least one modifier (Ctrl, Alt or Win). A bare key would stop you from typing it in every other app.',
    };
  }
  if (!hasPrimaryModifier) {
    return {
      ok: false,
      message: `"${normalized}" would interfere with normal typing in other apps. Include Ctrl, Alt or the Windows key.`,
    };
  }
  // A single Ctrl/Alt + ordinary key collides with copy, paste, zoom, menus and so on.
  if (modifiers.size === 1 && !modifiers.has('Super') && !fn) {
    return {
      ok: false,
      message: `"${normalized}" is used by most applications. Combine two modifiers, for example Ctrl+Shift+${/^[A-Z0-9]$/.test(key) ? key : 'C'}.`,
    };
  }
  if (OS_RESERVED.has(normalized)) {
    return { ok: false, message: `"${normalized}" is reserved by Windows and cannot be used.` };
  }
  return finish(normalized);
}

function finish(normalized: string): AcceleratorCheck {
  return { ok: true, normalized, display: normalized.split('+').join(' + ') };
}

export interface KeyEventLike {
  key: string;
  code: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
}

const MODIFIER_CODES = /^(Control|Alt|Shift|Meta|OS)(Left|Right)?$/;

/** Builds an accelerator string from a keydown event. Returns null while only modifiers are held. */
export function acceleratorFromKeyEvent(e: KeyEventLike): string | null {
  if (MODIFIER_CODES.test(e.code) || ['Control', 'Alt', 'Shift', 'Meta', 'OS'].includes(e.key)) return null;

  let key: string | null;
  if (/^Key[A-Z]$/.test(e.code)) key = e.code.slice(3);
  else if (/^Digit[0-9]$/.test(e.code)) key = e.code.slice(5);
  else if (/^F([1-9]|1[0-9]|2[0-4])$/.test(e.code)) key = e.code;
  else {
    const byCode: Record<string, string> = {
      Space: 'Space', Tab: 'Tab', Enter: 'Enter', Backspace: 'Backspace', Delete: 'Delete', Insert: 'Insert',
      Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown',
      ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
      Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Semicolon: ';', Quote: "'",
      Comma: ',', Period: '.', Slash: '/', Backslash: '\\', Backquote: '`',
    };
    key = byCode[e.code] ?? null;
  }
  if (key === null) return null;

  const mods: string[] = [];
  if (e.ctrlKey) mods.push('Ctrl');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  if (e.metaKey) mods.push('Super');
  return [...mods, key].join('+');
}
