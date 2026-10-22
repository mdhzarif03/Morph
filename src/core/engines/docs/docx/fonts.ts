/** Maps a Word font name to a CSS font stack with sensible fallbacks, and gives its natural line height. */

const SERIF = ['times new roman', 'cambria', 'georgia', 'garamond', 'book antiqua', 'palatino linotype', 'palatino', 'century', 'century schoolbook', 'baskerville', 'bookman old style', 'constantia', 'sitka text', 'minion pro', 'times'];
const MONO = ['courier new', 'consolas', 'cascadia mono', 'cascadia code', 'lucida console', 'courier', 'monaco', 'menlo'];

const ALIASES: Record<string, string[]> = {
  aptos: ['Aptos', 'Segoe UI', 'Calibri'],
  'aptos display': ['Aptos Display', 'Segoe UI Semibold', 'Segoe UI'],
  'aptos narrow': ['Aptos Narrow', 'Arial Narrow', 'Calibri'],
  'calibri light': ['Calibri Light', 'Calibri', 'Segoe UI Light'],
  'times new roman': ['Times New Roman', 'Liberation Serif', 'Times'],
  arial: ['Arial', 'Liberation Sans', 'Helvetica'],
  'courier new': ['Courier New', 'Liberation Mono', 'Courier'],
  calibri: ['Calibri', 'Carlito', 'Segoe UI'],
  cambria: ['Cambria', 'Caladea', 'Georgia'],
};

const NATURAL_LINE_HEIGHT: Record<string, number> = {
  'times new roman': 1.15,
  arial: 1.15,
  calibri: 1.22,
  'calibri light': 1.22,
  cambria: 1.17,
  'segoe ui': 1.33,
  verdana: 1.22,
  tahoma: 1.21,
  georgia: 1.14,
  'courier new': 1.13,
  consolas: 1.17,
  aptos: 1.2,
  'aptos display': 1.2,
};

// Single quotes: the stack is placed inside a double-quoted style attribute.
const quote = (name: string): string => `'${name.replace(/['"\\<>&]/g, '')}'`;

export function fontStack(font: string): string {
  const key = font.trim().toLowerCase();
  const names = ALIASES[key] ?? [font.trim()];
  const generic = SERIF.includes(key) ? 'serif' : MONO.includes(key) ? 'monospace' : 'sans-serif';
  return `${names.map(quote).join(', ')}, ${generic}`;
}

export function naturalLineHeight(font: string | undefined): number {
  return NATURAL_LINE_HEIGHT[(font ?? '').trim().toLowerCase()] ?? 1.2;
}
