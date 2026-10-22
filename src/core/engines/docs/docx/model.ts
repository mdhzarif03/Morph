import { attr, child, children, kids, onOff, rootOf, tagOf, type XNode } from './xml';

// ---------------------------------------------------------------------------------------------
// Property models (units: points unless noted)

export interface Border {
  style: string; // CSS border-style, or 'none'
  widthPt: number;
  color: string;
}
export interface Borders {
  top?: Border;
  right?: Border;
  bottom?: Border;
  left?: Border;
  insideH?: Border;
  insideV?: Border;
}

export interface PProps {
  jc?: 'left' | 'center' | 'right' | 'justify';
  before?: number;
  after?: number;
  line?: { rule: 'auto' | 'exact' | 'atLeast'; value: number };
  left?: number;
  right?: number;
  firstLine?: number;
  hanging?: number;
  keepNext?: boolean;
  pageBreakBefore?: boolean;
  contextual?: boolean;
  shd?: string;
  borders?: Borders;
  numId?: string;
  ilvl?: number;
}

export interface RProps {
  font?: string;
  size?: number;
  b?: boolean;
  i?: boolean;
  u?: boolean;
  strike?: boolean;
  color?: string;
  highlight?: string;
  vert?: 'super' | 'sub' | 'baseline';
  caps?: boolean;
  smallCaps?: boolean;
  spacing?: number;
  shd?: string;
  vanish?: boolean;
}

export interface Theme {
  major?: string;
  minor?: string;
  colors: Record<string, string>;
}

const HIGHLIGHT: Record<string, string> = {
  yellow: '#ffff00', green: '#00ff00', cyan: '#00ffff', magenta: '#ff00ff', blue: '#0000ff', red: '#ff0000',
  darkBlue: '#000080', darkCyan: '#008080', darkGreen: '#008000', darkMagenta: '#800080', darkRed: '#800000',
  darkYellow: '#808000', darkGray: '#808080', lightGray: '#c0c0c0', black: '#000000', white: '#ffffff',
};

const num = (v: string | undefined): number | undefined => {
  if (v === undefined || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};
const twipsToPt = (v: string | undefined): number | undefined => {
  const n = num(v);
  return n === undefined ? undefined : n / 20;
};
const isHex = (v: string | undefined): v is string => v !== undefined && /^[0-9a-fA-F]{6}$/.test(v);

export function parseTheme(root: XNode[] | null): Theme {
  const theme: Theme = { colors: {} };
  if (!root) return theme;
  const find = (nodes: XNode[], tag: string): XNode | undefined => {
    for (const n of nodes) {
      if (tagOf(n) === tag) return n;
      const inner = find(kids(n), tag);
      if (inner) return inner;
    }
    return undefined;
  };
  const major = find(root, 'a:majorFont');
  const minor = find(root, 'a:minorFont');
  theme.major = attr(child(major, 'a:latin'), 'typeface');
  theme.minor = attr(child(minor, 'a:latin'), 'typeface');
  const scheme = find(root, 'a:clrScheme');
  for (const entry of kids(scheme)) {
    const name = tagOf(entry).replace('a:', '');
    const srgb = child(entry, 'a:srgbClr');
    const sys = child(entry, 'a:sysClr');
    const value = attr(srgb, 'val') ?? attr(sys, 'lastClr');
    if (isHex(value)) theme.colors[name] = `#${value}`;
  }
  // Word's names for the same slots.
  theme.colors.text1 = theme.colors.dk1 ?? '#000000';
  theme.colors.background1 = theme.colors.lt1 ?? '#ffffff';
  theme.colors.text2 = theme.colors.dk2 ?? '#44546a';
  theme.colors.background2 = theme.colors.lt2 ?? '#e7e6e6';
  return theme;
}

function themeFont(name: string | undefined, theme: Theme): string | undefined {
  if (!name) return undefined;
  if (name.startsWith('major')) return theme.major;
  if (name.startsWith('minor')) return theme.minor;
  return undefined;
}

export function readBorder(node: XNode | undefined, theme: Theme): Border | undefined {
  if (!node) return undefined;
  const val = attr(node, 'w:val') ?? 'single';
  if (val === 'nil' || val === 'none') return { style: 'none', widthPt: 0, color: '#000000' };
  const sz = num(attr(node, 'w:sz')) ?? 4;
  const colorAttr = attr(node, 'w:color');
  let color = isHex(colorAttr) ? `#${colorAttr}` : '#000000';
  if (!isHex(colorAttr)) {
    const t = attr(node, 'w:themeColor');
    if (t && theme.colors[t]) color = theme.colors[t];
  }
  const style = /double/.test(val) ? 'double' : /dash/i.test(val) ? 'dashed' : /dot/i.test(val) ? 'dotted' : 'solid';
  return { style, widthPt: Math.max(0.25, sz / 8), color };
}

export function readBorders(node: XNode | undefined, theme: Theme): Borders | undefined {
  if (!node) return undefined;
  const borders: Borders = {};
  const map: Array<[keyof Borders, string[]]> = [
    ['top', ['w:top']], ['bottom', ['w:bottom']], ['left', ['w:left', 'w:start']], ['right', ['w:right', 'w:end']],
    ['insideH', ['w:insideH']], ['insideV', ['w:insideV']],
  ];
  for (const [key, tags] of map) {
    for (const tag of tags) {
      const b = readBorder(child(node, tag), theme);
      if (b) borders[key] = b;
    }
  }
  return Object.keys(borders).length > 0 ? borders : undefined;
}

export function shading(node: XNode | undefined, theme: Theme): string | undefined {
  const shd = child(node, 'w:shd');
  if (!shd) return undefined;
  const fill = attr(shd, 'w:fill');
  if (isHex(fill)) return `#${fill}`;
  const t = attr(shd, 'w:themeFill');
  return t ? theme.colors[t] : undefined;
}

export function readPPr(node: XNode | undefined, theme: Theme): PProps {
  const p: PProps = {};
  if (!node) return p;
  const jc = attr(child(node, 'w:jc'), 'w:val');
  if (jc === 'center') p.jc = 'center';
  else if (jc === 'right' || jc === 'end') p.jc = 'right';
  else if (jc === 'both' || jc === 'distribute') p.jc = 'justify';
  else if (jc === 'left' || jc === 'start') p.jc = 'left';

  const spacing = child(node, 'w:spacing');
  if (spacing) {
    const before = twipsToPt(attr(spacing, 'w:before'));
    const after = twipsToPt(attr(spacing, 'w:after'));
    if (before !== undefined) p.before = before;
    if (after !== undefined) p.after = after;
    const line = num(attr(spacing, 'w:line'));
    if (line !== undefined) {
      const rule = attr(spacing, 'w:lineRule');
      p.line = rule === 'exact' ? { rule: 'exact', value: line / 20 } : rule === 'atLeast' ? { rule: 'atLeast', value: line / 20 } : { rule: 'auto', value: line / 240 };
    }
  }
  const ind = child(node, 'w:ind');
  if (ind) {
    const left = twipsToPt(attr(ind, 'w:left') ?? attr(ind, 'w:start'));
    const right = twipsToPt(attr(ind, 'w:right') ?? attr(ind, 'w:end'));
    const first = twipsToPt(attr(ind, 'w:firstLine'));
    const hanging = twipsToPt(attr(ind, 'w:hanging'));
    if (left !== undefined) p.left = left;
    if (right !== undefined) p.right = right;
    if (first !== undefined) { p.firstLine = first; p.hanging = 0; }
    if (hanging !== undefined) { p.hanging = hanging; p.firstLine = 0; }
  }
  const keepNext = onOff(child(node, 'w:keepNext'));
  if (keepNext !== undefined) p.keepNext = keepNext;
  const pbb = onOff(child(node, 'w:pageBreakBefore'));
  if (pbb !== undefined) p.pageBreakBefore = pbb;
  const ctx = onOff(child(node, 'w:contextualSpacing'));
  if (ctx !== undefined) p.contextual = ctx;
  const shd = shading(node, theme);
  if (shd) p.shd = shd;
  const borders = readBorders(child(node, 'w:pBdr'), theme);
  if (borders) p.borders = borders;
  const numPr = child(node, 'w:numPr');
  if (numPr) {
    const numId = attr(child(numPr, 'w:numId'), 'w:val');
    if (numId !== undefined) p.numId = numId;
    const ilvl = num(attr(child(numPr, 'w:ilvl'), 'w:val'));
    if (ilvl !== undefined) p.ilvl = ilvl;
  }
  return p;
}

export function readRPr(node: XNode | undefined, theme: Theme): RProps {
  const r: RProps = {};
  if (!node) return r;
  const fonts = child(node, 'w:rFonts');
  if (fonts) {
    const themed = themeFont(attr(fonts, 'w:asciiTheme') ?? attr(fonts, 'w:hAnsiTheme'), theme);
    const font = attr(fonts, 'w:ascii') ?? attr(fonts, 'w:hAnsi') ?? themed;
    if (font) r.font = font;
    else if (themed) r.font = themed;
  }
  const sz = num(attr(child(node, 'w:sz'), 'w:val'));
  if (sz !== undefined) r.size = sz / 2;
  const b = onOff(child(node, 'w:b')); if (b !== undefined) r.b = b;
  const i = onOff(child(node, 'w:i')); if (i !== undefined) r.i = i;
  const uNode = child(node, 'w:u');
  if (uNode) r.u = (attr(uNode, 'w:val') ?? 'single') !== 'none';
  const strike = onOff(child(node, 'w:strike')) ?? onOff(child(node, 'w:dstrike')); if (strike !== undefined) r.strike = strike;
  const colorNode = child(node, 'w:color');
  if (colorNode) {
    const val = attr(colorNode, 'w:val');
    const t = attr(colorNode, 'w:themeColor');
    if (isHex(val)) r.color = `#${val}`;
    else if (t && theme.colors[t]) r.color = theme.colors[t];
  }
  const hl = attr(child(node, 'w:highlight'), 'w:val');
  if (hl && HIGHLIGHT[hl]) r.highlight = HIGHLIGHT[hl];
  const va = attr(child(node, 'w:vertAlign'), 'w:val');
  if (va === 'superscript') r.vert = 'super'; else if (va === 'subscript') r.vert = 'sub'; else if (va === 'baseline') r.vert = 'baseline';
  const caps = onOff(child(node, 'w:caps')); if (caps !== undefined) r.caps = caps;
  const sc = onOff(child(node, 'w:smallCaps')); if (sc !== undefined) r.smallCaps = sc;
  const spacing = twipsToPt(attr(child(node, 'w:spacing'), 'w:val')); if (spacing !== undefined) r.spacing = spacing;
  const shd = shading(node, theme); if (shd) r.shd = shd;
  const vanish = onOff(child(node, 'w:vanish')); if (vanish !== undefined) r.vanish = vanish;
  return r;
}

export const mergeP = (...parts: Array<PProps | undefined>): PProps => Object.assign({}, ...parts.map((p) => stripUndefined(p ?? {}))) as PProps;
export const mergeR = (...parts: Array<RProps | undefined>): RProps => Object.assign({}, ...parts.map((p) => stripUndefined(p ?? {}))) as RProps;
function stripUndefined<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}

// ---------------------------------------------------------------------------------------------
// Styles

export interface TableConditional {
  r: RProps;
  p: PProps;
  shd?: string;
  borders?: Borders;
}

export interface StyleDef {
  id: string;
  type: string;
  basedOn?: string;
  isDefault: boolean;
  p: PProps;
  r: RProps;
  /** Table styles only. */
  tableBorders?: Borders;
  cellMar?: { top?: number; right?: number; bottom?: number; left?: number };
  conditionals: Map<string, TableConditional>;
}

export interface StyleSet {
  defaults: { p: PProps; r: RProps };
  styles: Map<string, StyleDef>;
  defaultParagraphStyle?: string;
  defaultTableStyle?: string;
}

function readCellMar(node: XNode | undefined): StyleDef['cellMar'] {
  if (!node) return undefined;
  const mar: NonNullable<StyleDef['cellMar']> = {};
  for (const [key, tags] of [['top', ['w:top']], ['bottom', ['w:bottom']], ['left', ['w:left', 'w:start']], ['right', ['w:right', 'w:end']]] as const) {
    for (const tag of tags) {
      const v = twipsToPt(attr(child(node, tag), 'w:w'));
      if (v !== undefined) mar[key] = v;
    }
  }
  return mar;
}

export function parseStyles(root: XNode[] | null, theme: Theme): StyleSet {
  const set: StyleSet = { defaults: { p: {}, r: {} }, styles: new Map() };
  const stylesRoot = root ? rootOf(root, 'w:styles') : undefined;
  if (!stylesRoot) return set;
  const dd = child(stylesRoot, 'w:docDefaults');
  set.defaults.r = readRPr(child(child(dd, 'w:rPrDefault'), 'w:rPr'), theme);
  set.defaults.p = readPPr(child(child(dd, 'w:pPrDefault'), 'w:pPr'), theme);

  for (const node of children(stylesRoot, 'w:style')) {
    const id = attr(node, 'w:styleId');
    if (!id) continue;
    const type = attr(node, 'w:type') ?? 'paragraph';
    const def: StyleDef = {
      id,
      type,
      isDefault: attr(node, 'w:default') === '1' || attr(node, 'w:default') === 'true',
      p: readPPr(child(node, 'w:pPr'), theme),
      r: readRPr(child(node, 'w:rPr'), theme),
      conditionals: new Map(),
    };
    const basedOn = attr(child(node, 'w:basedOn'), 'w:val');
    if (basedOn) def.basedOn = basedOn;
    const tblPr = child(node, 'w:tblPr');
    if (tblPr) {
      const b = readBorders(child(tblPr, 'w:tblBorders'), theme);
      if (b) def.tableBorders = b;
      const mar = readCellMar(child(tblPr, 'w:tblCellMar'));
      if (mar) def.cellMar = mar;
    }
    for (const cond of children(node, 'w:tblStylePr')) {
      const t = attr(cond, 'w:type');
      if (!t) continue;
      const tcPr = child(cond, 'w:tcPr');
      const c: TableConditional = { r: readRPr(child(cond, 'w:rPr'), theme), p: readPPr(child(cond, 'w:pPr'), theme) };
      const shd = shading(tcPr, theme);
      if (shd) c.shd = shd;
      const borders = readBorders(child(tcPr, 'w:tcBorders'), theme);
      if (borders) c.borders = borders;
      def.conditionals.set(t, c);
    }
    set.styles.set(id, def);
    if (def.isDefault && type === 'paragraph') set.defaultParagraphStyle = id;
    if (def.isDefault && type === 'table') set.defaultTableStyle = id;
  }
  return set;
}

/** Style chain from the root ancestor down to `id` (cycle-safe). */
function chain(set: StyleSet, id: string | undefined): StyleDef[] {
  const out: StyleDef[] = [];
  const seen = new Set<string>();
  let current = id ? set.styles.get(id) : undefined;
  while (current && !seen.has(current.id) && out.length < 30) {
    seen.add(current.id);
    out.unshift(current);
    current = current.basedOn ? set.styles.get(current.basedOn) : undefined;
  }
  return out;
}

export function resolveStyle(set: StyleSet, id: string | undefined): { p: PProps; r: RProps } {
  const defs = chain(set, id);
  return { p: mergeP(...defs.map((d) => d.p)), r: mergeR(...defs.map((d) => d.r)) };
}

export function resolveTableStyle(set: StyleSet, id: string | undefined): { def: StyleDef | undefined; p: PProps; r: RProps; borders?: Borders; cellMar?: StyleDef['cellMar']; conditionals: Map<string, TableConditional> } {
  const defs = chain(set, id ?? set.defaultTableStyle);
  const conditionals = new Map<string, TableConditional>();
  for (const d of defs) for (const [k, v] of d.conditionals) conditionals.set(k, v);
  const borders = Object.assign({}, ...defs.map((d) => d.tableBorders ?? {})) as Borders;
  const cellMar = Object.assign({}, ...defs.map((d) => d.cellMar ?? {})) as StyleDef['cellMar'];
  return {
    def: defs[defs.length - 1],
    p: mergeP(...defs.map((d) => d.p)),
    r: mergeR(...defs.map((d) => d.r)),
    ...(Object.keys(borders).length > 0 ? { borders } : {}),
    ...(cellMar && Object.keys(cellMar).length > 0 ? { cellMar } : {}),
    conditionals,
  };
}

// ---------------------------------------------------------------------------------------------
// Numbering

export interface NumLevel {
  fmt: string;
  text: string;
  start: number;
  left?: number;
  hanging?: number;
  r: RProps;
}

export interface Numbering {
  abstracts: Map<string, Map<number, NumLevel>>;
  nums: Map<string, { abstractId: string; startOverrides: Map<number, number> }>;
}

export function parseNumbering(root: XNode[] | null, theme: Theme): Numbering {
  const out: Numbering = { abstracts: new Map(), nums: new Map() };
  const numRoot = root ? rootOf(root, 'w:numbering') : undefined;
  if (!numRoot) return out;
  for (const abs of children(numRoot, 'w:abstractNum')) {
    const id = attr(abs, 'w:abstractNumId');
    if (id === undefined) continue;
    const levels = new Map<number, NumLevel>();
    for (const lvl of children(abs, 'w:lvl')) {
      const ilvl = num(attr(lvl, 'w:ilvl'));
      if (ilvl === undefined) continue;
      const ind = readPPr(child(lvl, 'w:pPr'), theme);
      levels.set(ilvl, {
        fmt: attr(child(lvl, 'w:numFmt'), 'w:val') ?? 'decimal',
        text: attr(child(lvl, 'w:lvlText'), 'w:val') ?? `%${ilvl + 1}.`,
        start: num(attr(child(lvl, 'w:start'), 'w:val')) ?? 1,
        ...(ind.left !== undefined ? { left: ind.left } : {}),
        ...(ind.hanging !== undefined ? { hanging: ind.hanging } : {}),
        r: readRPr(child(lvl, 'w:rPr'), theme),
      });
    }
    out.abstracts.set(id, levels);
  }
  for (const n of children(numRoot, 'w:num')) {
    const id = attr(n, 'w:numId');
    const abstractId = attr(child(n, 'w:abstractNumId'), 'w:val');
    if (id === undefined || abstractId === undefined) continue;
    const startOverrides = new Map<number, number>();
    for (const o of children(n, 'w:lvlOverride')) {
      const l = num(attr(o, 'w:ilvl'));
      const s = num(attr(child(o, 'w:startOverride'), 'w:val'));
      if (l !== undefined && s !== undefined) startOverrides.set(l, s);
    }
    out.nums.set(id, { abstractId, startOverrides });
  }
  return out;
}

const ROMAN: Array<[number, string]> = [[1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'], [100, 'c'], [90, 'xc'], [50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i']];

export function formatNumber(value: number, fmt: string): string {
  switch (fmt) {
    case 'decimalZero': return String(value).padStart(2, '0');
    case 'lowerLetter':
    case 'upperLetter': {
      let n = Math.max(1, value);
      let s = '';
      while (n > 0) { n -= 1; s = String.fromCharCode(97 + (n % 26)) + s; n = Math.floor(n / 26); }
      return fmt === 'upperLetter' ? s.toUpperCase() : s;
    }
    case 'lowerRoman':
    case 'upperRoman': {
      let n = Math.min(3999, Math.max(1, value));
      let s = '';
      for (const [v, sym] of ROMAN) while (n >= v) { s += sym; n -= v; }
      return fmt === 'upperRoman' ? s.toUpperCase() : s;
    }
    case 'bullet': return '•';
    case 'none': return '';
    default: return String(value);
  }
}

const SYMBOL_BULLETS: Record<string, string> = { '': '•', '': '▪', '': '➢', '': '✓', '': '❖', '': '◦', o: '◦', '•': '•' };

export function bulletGlyph(text: string): string {
  const trimmed = text.trim();
  if (SYMBOL_BULLETS[trimmed]) return SYMBOL_BULLETS[trimmed];
  if (/^[-]$/.test(trimmed)) return '•';
  return trimmed || '•';
}

/** Running list counters, in document order, the way Word numbers paragraphs. */
export class NumberingState {
  private readonly counters = new Map<string, number[]>();
  constructor(private readonly numbering: Numbering) {}

  label(numId: string, ilvl: number): { text: string; level: NumLevel } | null {
    const num = this.numbering.nums.get(numId);
    const levels = num ? this.numbering.abstracts.get(num.abstractId) : undefined;
    const level = levels?.get(ilvl);
    if (!num || !levels || !level) return null;

    const counters = this.counters.get(numId) ?? [];
    const startFor = (l: number): number => num.startOverrides.get(l) ?? levels.get(l)?.start ?? 1;
    counters[ilvl] = counters[ilvl] === undefined ? startFor(ilvl) : (counters[ilvl]) + 1;
    counters.length = ilvl + 1; // deeper levels restart
    this.counters.set(numId, counters);

    if (level.fmt === 'bullet') return { text: bulletGlyph(level.text), level };
    const text = level.text.replace(/%([1-9])/g, (_, d: string) => {
      const l = Number(d) - 1;
      const value = counters[l] ?? startFor(l);
      return formatNumber(value, levels.get(l)?.fmt ?? 'decimal');
    });
    return { text, level };
  }
}
