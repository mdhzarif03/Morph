import { escapeHtml } from '../html';
import { fontStack, naturalLineHeight } from './fonts';
import {
  NumberingState,
  mergeP,
  mergeR,
  readBorders,
  readPPr,
  shading,
  readRPr,
  resolveStyle,
  resolveTableStyle,
  type Border,
  type Borders,
  type Numbering,
  type PProps,
  type RProps,
  type StyleSet,
  type TableConditional,
  type Theme,
} from './model';
import { attr, child, children, findDeep, kids, tagOf, textOf, type XNode } from './xml';

export interface Relationship {
  target: string;
  external: boolean;
  type: string;
}

export interface RenderInput {
  theme: Theme;
  styles: StyleSet;
  numbering: Numbering;
  rels: Map<string, Relationship>;
  /** rId -> data URI, prefetched. */
  images: Map<string, string>;
}

const MAX_DEPTH = 40;
const f = (n: number): string => String(Math.round(n * 100) / 100);

const borderCss = (b: Border | undefined): string | undefined => (b ? (b.style === 'none' ? 'none' : `${f(b.widthPt)}pt ${b.style} ${b.color}`) : undefined);

export class Renderer {
  readonly warnings = new Set<string>();
  private readonly numbering: NumberingState;

  constructor(private readonly input: RenderInput) {
    this.numbering = new NumberingState(input.numbering);
  }

  // -------------------------------------------------------------------------------------------
  // Effective properties

  private effectiveParagraph(styleId: string | undefined, table?: { p: PProps; r: RProps }): { p: PProps; r: RProps; styleKey: string } {
    const { styles } = this.input;
    const id = styleId ?? styles.defaultParagraphStyle;
    const style = resolveStyle(styles, id);
    return {
      p: mergeP(styles.defaults.p, table?.p, style.p),
      r: mergeR(styles.defaults.r, table?.r, style.r),
      styleKey: id ?? '',
    };
  }

  private runCss(r: RProps, base: RProps | null): string {
    const css: string[] = [];
    const differs = <K extends keyof RProps>(k: K): boolean => base === null || r[k] !== base[k];
    if (r.font && differs('font')) css.push(`font-family:${fontStack(r.font)}`);
    if (r.size !== undefined && differs('size')) css.push(`font-size:${f(r.size)}pt`);
    if (differs('b') && (r.b !== undefined || base?.b !== undefined)) css.push(`font-weight:${r.b ? 'bold' : 'normal'}`);
    if (differs('i') && (r.i !== undefined || base?.i !== undefined)) css.push(`font-style:${r.i ? 'italic' : 'normal'}`);
    if (differs('u') || differs('strike')) {
      const deco = [r.u ? 'underline' : '', r.strike ? 'line-through' : ''].filter(Boolean).join(' ');
      if (deco || base?.u || base?.strike) css.push(`text-decoration:${deco || 'none'}`);
    }
    if (r.color && differs('color')) css.push(`color:${r.color}`);
    if (r.highlight && differs('highlight')) css.push(`background-color:${r.highlight}`);
    else if (r.shd && differs('shd')) css.push(`background-color:${r.shd}`);
    if (r.vert && r.vert !== 'baseline' && differs('vert')) css.push(`vertical-align:${r.vert === 'super' ? 'super' : 'sub'};font-size:${f((r.size ?? 11) * 0.65)}pt`);
    if (differs('caps') && r.caps !== undefined) css.push(`text-transform:${r.caps ? 'uppercase' : 'none'}`);
    if (differs('smallCaps') && r.smallCaps !== undefined) css.push(`font-variant:${r.smallCaps ? 'small-caps' : 'normal'}`);
    if (r.spacing !== undefined && differs('spacing')) css.push(`letter-spacing:${f(r.spacing)}pt`);
    return css.join(';');
  }

  private paragraphCss(p: PProps, r: RProps, opts: { sameStyleBefore: boolean; sameStyleAfter: boolean }): string {
    const css: string[] = [];
    const base = this.runCss(r, null);
    if (base) css.push(base);
    if (p.jc) css.push(`text-align:${p.jc}`);
    const contextual = p.contextual === true;
    const before = contextual && opts.sameStyleBefore ? 0 : (p.before ?? 0);
    const after = contextual && opts.sameStyleAfter ? 0 : (p.after ?? 0);
    // Padding, not margin: Word adds the spacing of neighbouring paragraphs, CSS margins would collapse.
    css.push(`padding-top:${f(before)}pt`, `padding-bottom:${f(after)}pt`);
    if (p.left) css.push(`margin-left:${f(p.left)}pt`);
    if (p.right) css.push(`margin-right:${f(p.right)}pt`);
    if (p.firstLine) css.push(`text-indent:${f(p.firstLine)}pt`);
    else if (p.hanging) css.push(`text-indent:${f(-p.hanging)}pt`);
    if (p.line) {
      if (p.line.rule === 'auto') css.push(`line-height:${f(p.line.value * naturalLineHeight(r.font))}`);
      else css.push(`line-height:${f(p.line.value)}pt`);
    } else css.push(`line-height:${f(naturalLineHeight(r.font))}`);
    if (p.shd) css.push(`background-color:${p.shd}`);
    if (p.borders) {
      for (const side of ['top', 'right', 'bottom', 'left'] as const) {
        const b = borderCss(p.borders[side]);
        if (b) css.push(`border-${side}:${b}`);
      }
    }
    if (p.keepNext) css.push('break-after:avoid');
    if (p.pageBreakBefore) css.push('break-before:page');
    return css.join(';');
  }

  // -------------------------------------------------------------------------------------------
  // Blocks

  blocks(nodes: XNode[], depth = 0, table?: { p: PProps; r: RProps }): string {
    if (depth > MAX_DEPTH) return '';
    let out = '';
    const list = nodes.filter((n) => ['w:p', 'w:tbl', 'w:sdt'].includes(tagOf(n)));
    for (const [index, node] of list.entries()) {
      switch (tagOf(node)) {
        case 'w:p': {
          const styleOf = (n: XNode | undefined): string | undefined => (n && tagOf(n) === 'w:p' ? attr(child(child(n, 'w:pPr'), 'w:pStyle'), 'w:val') : undefined);
          const prev = list[index - 1];
          const next = list[index + 1];
          const mine = styleOf(node);
          out += this.paragraph(node, {
            table,
            sameStyleBefore: prev !== undefined && tagOf(prev) === 'w:p' && styleOf(prev) === mine,
            sameStyleAfter: next !== undefined && tagOf(next) === 'w:p' && styleOf(next) === mine,
          });
          break;
        }
        case 'w:tbl':
          out += this.table(node, depth, table);
          break;
        case 'w:sdt':
          out += this.blocks(kids(child(node, 'w:sdtContent')), depth + 1, table);
          break;
      }
    }
    return out;
  }

  private paragraph(node: XNode, opts: { table: { p: PProps; r: RProps } | undefined; sameStyleBefore: boolean; sameStyleAfter: boolean }): string {
    const pPr = child(node, 'w:pPr');
    const styleId = attr(child(pPr, 'w:pStyle'), 'w:val');
    const eff = this.effectiveParagraph(styleId, opts.table);
    const direct = readPPr(pPr, this.input.theme);
    let p = mergeP(eff.p, direct);
    const r = eff.r;

    // Paragraph-mark run properties (used for empty paragraphs).
    const markR = readRPr(child(pPr, 'w:rPr'), this.input.theme);

    // Lists
    let marker = '';
    if (p.numId && p.numId !== '0') {
      const label = this.numbering.label(p.numId, p.ilvl ?? 0);
      if (label) {
        const hanging = direct.hanging ?? label.level.hanging ?? p.hanging ?? 18;
        const left = direct.left ?? label.level.left ?? p.left ?? hanging;
        p = { ...p, left, hanging, firstLine: 0 };
        const markerCss = this.runCss(mergeR(r, label.level.r), r);
        marker = `<span style="display:inline-block;min-width:${f(hanging)}pt;text-indent:0${markerCss ? `;${markerCss}` : ''}">${escapeHtml(label.text)}</span>`;
      }
    }
    const inner = this.inline(kids(node), r, 0);
    // Line height follows the font the text is actually set in (direct run formatting often overrides the style).
    const firstRun = kids(node).find((n) => tagOf(n) === 'w:r' && child(n, 'w:t'));
    const runFont = firstRun ? readRPr(child(firstRun, 'w:rPr'), this.input.theme).font : undefined;
    const cssFont = mergeR(r, inner.trim() === '' ? markR : undefined);
    const css = this.paragraphCss(p, runFont && inner.trim() !== '' ? { ...cssFont, font: runFont } : cssFont, opts);
    const content = inner.trim() === '' && marker === '' ? '&#8203;' : inner;
    return `<p style="${css}">${marker}${content}</p>\n`;
  }

  // -------------------------------------------------------------------------------------------
  // Inline content

  private inline(nodes: XNode[], paragraphR: RProps, depth: number): string {
    if (depth > MAX_DEPTH) return '';
    let out = '';
    for (const node of nodes) {
      switch (tagOf(node)) {
        case 'w:r':
          out += this.run(node, paragraphR);
          break;
        case 'w:hyperlink': {
          const inner = this.inline(kids(node), paragraphR, depth + 1);
          const rid = attr(node, 'r:id');
          const rel = rid ? this.input.rels.get(rid) : undefined;
          const href = rel?.external ? safeHref(rel.target) : undefined;
          out += href ? `<a href="${escapeHtml(href)}">${inner}</a>` : inner;
          break;
        }
        case 'w:fldSimple':
        case 'w:ins':
        case 'w:smartTag':
        case 'w:customXml':
        case 'w:moveTo':
          out += this.inline(kids(node), paragraphR, depth + 1);
          break;
        case 'w:sdt':
          out += this.inline(kids(child(node, 'w:sdtContent')), paragraphR, depth + 1);
          break;
        case 'mc:AlternateContent': {
          const choice = child(node, 'mc:Choice');
          if (findDeep(choice, 'a:blip')) out += this.inline(kids(choice), paragraphR, depth + 1);
          else this.warnings.add('Some text boxes, shapes or charts could not be reproduced and were left out.');
          break;
        }
        default:
          break; // w:pPr, bookmarks, proofing marks, deletions, comments...
      }
    }
    return out;
  }

  private run(node: XNode, paragraphR: RProps): string {
    const rPr = child(node, 'w:rPr');
    const rStyle = attr(child(rPr, 'w:rStyle'), 'w:val');
    const charStyle = rStyle ? resolveStyle(this.input.styles, rStyle).r : undefined;
    const props = mergeR(paragraphR, charStyle, readRPr(rPr, this.input.theme));
    if (props.vanish) return '';

    let html = '';
    for (const part of kids(node)) {
      switch (tagOf(part)) {
        case 'w:t':
          html += escapeHtml(textOf(part));
          break;
        case 'w:tab':
          html += '<span style="display:inline-block;width:36pt"></span>';
          break;
        case 'w:br': {
          const type = attr(part, 'w:type');
          if (type === 'page') html += '<span style="display:block;break-after:page"></span>';
          else if (type !== 'column') html += '<br>';
          break;
        }
        case 'w:cr':
          html += '<br>';
          break;
        case 'w:noBreakHyphen':
          html += '\u2011';
          break;
        case 'w:softHyphen':
          html += '&shy;';
          break;
        case 'w:drawing':
          html += this.drawing(part);
          break;
        case 'w:pict':
        case 'w:object':
          this.warnings.add('Some text boxes, shapes or embedded objects could not be reproduced and were left out.');
          break;
        case 'w:footnoteReference':
        case 'w:endnoteReference':
          this.warnings.add('Footnotes and endnotes are not included.');
          break;
        default:
          break;
      }
    }
    if (html === '') return '';
    const css = this.runCss(props, paragraphR);
    return css ? `<span style="white-space:pre-wrap;${css}">${html}</span>` : `<span style="white-space:pre-wrap">${html}</span>`;
  }

  private drawing(node: XNode): string {
    const blip = findDeep(node, 'a:blip');
    const rid = attr(blip, 'r:embed');
    if (!rid) {
      this.warnings.add('Some drawings, charts or shapes could not be reproduced and were left out.');
      return '';
    }
    const data = this.input.images.get(rid);
    if (!data) {
      this.warnings.add('Some pictures in this document are in a format that is not supported and were left out.');
      return '';
    }
    const extent = findDeep(node, 'wp:extent');
    const cx = Number(attr(extent, 'cx'));
    const cy = Number(attr(extent, 'cy'));
    const size = Number.isFinite(cx) && Number.isFinite(cy) && cx > 0 && cy > 0 ? `width:${f(cx / 12700)}pt;height:${f(cy / 12700)}pt;` : '';
    const alt = attr(findDeep(node, 'wp:docPr'), 'descr') ?? '';
    return `<img src="${data}" alt="${escapeHtml(alt)}" style="${size}max-width:100%;vertical-align:bottom">`;
  }

  // -------------------------------------------------------------------------------------------
  // Tables

  private table(node: XNode, depth: number, outerTable: { p: PProps; r: RProps } | undefined): string {
    const { theme, styles } = this.input;
    const tblPr = child(node, 'w:tblPr');
    const styleId = attr(child(tblPr, 'w:tblStyle'), 'w:val');
    const style = resolveTableStyle(styles, styleId);

    const grid = children(child(node, 'w:tblGrid'), 'w:gridCol').map((c) => Number(attr(c, 'w:w') ?? 0) / 20);
    const direct = readBorders(child(tblPr, 'w:tblBorders'), theme);
    const tableBorders: Borders = { ...(style.borders ?? {}), ...(direct ?? {}) };

    const marNode = child(tblPr, 'w:tblCellMar');
    const readMar = (tag: string, fallback: number): number => {
      const v = Number(attr(child(marNode, tag), 'w:w'));
      return Number.isFinite(v) && attr(child(marNode, tag), 'w:w') !== undefined ? v / 20 : fallback;
    };
    const cellMar = {
      top: readMar('w:top', style.cellMar?.top ?? 0),
      bottom: readMar('w:bottom', style.cellMar?.bottom ?? 0),
      left: readMar('w:left', style.cellMar?.left ?? 5.4),
      right: readMar('w:right', style.cellMar?.right ?? 5.4),
    };

    const look = attr(child(tblPr, 'w:tblLook'), 'w:val');
    const lookBits = look ? parseInt(look, 16) : 0x04a0;
    const flag = (bit: number, name: string): boolean => {
      const explicit = attr(child(tblPr, 'w:tblLook'), `w:${name}`);
      return explicit !== undefined ? explicit === '1' || explicit === 'true' : (lookBits & bit) !== 0;
    };
    const firstRow = flag(0x20, 'firstRow');
    const lastRow = flag(0x40, 'lastRow');
    const firstCol = flag(0x80, 'firstColumn');
    const lastCol = flag(0x100, 'lastColumn');
    const bandRows = !flag(0x200, 'noHBand');

    const rows = children(node, 'w:tr');
    // Pass 1: lay cells on the grid so vertical merges can be turned into rowspans.
    interface Cell { node: XNode; col: number; span: number; vMerge: 'restart' | 'continue' | null; rowSpan: number; hidden: boolean }
    const matrix: Cell[][] = rows.map((row) => {
      const cells: Cell[] = [];
      let col = 0;
      const gridBefore = Number(attr(child(child(row, 'w:trPr'), 'w:gridBefore'), 'w:val') ?? 0);
      col += gridBefore;
      for (const tc of children(row, 'w:tc')) {
        const tcPr = child(tc, 'w:tcPr');
        const span = Math.max(1, Number(attr(child(tcPr, 'w:gridSpan'), 'w:val') ?? 1));
        const vm = child(tcPr, 'w:vMerge');
        const vMerge = vm ? (attr(vm, 'w:val') === 'restart' ? 'restart' : 'continue') : null;
        cells.push({ node: tc, col, span, vMerge, rowSpan: 1, hidden: vMerge === 'continue' });
        col += span;
      }
      return cells;
    });
    matrix.forEach((cells, r) => {
      for (const cell of cells) {
        if (cell.vMerge !== 'restart') continue;
        let n = 1;
        while (r + n < matrix.length) {
          const below = matrix[r + n]?.find((c) => c.col === cell.col);
          if (below?.vMerge === 'continue') n += 1;
          else break;
        }
        cell.rowSpan = n;
      }
    });

    const totalCols = grid.length > 0 ? grid.length : Math.max(1, ...matrix.map((cells) => cells.reduce((s, c) => s + c.span, 0)));
    const gridWidth = grid.reduce((s, w) => s + w, 0);
    const tblW = child(tblPr, 'w:tblW');
    const wType = attr(tblW, 'w:type');
    const wVal = Number(attr(tblW, 'w:w') ?? 0);
    let widthCss = gridWidth > 0 ? `width:${f(gridWidth)}pt` : 'width:100%';
    if (wType === 'pct' && wVal > 0) widthCss = `width:${f(wVal / 50)}%`;
    else if (wType === 'dxa' && wVal > 0) widthCss = `width:${f(wVal / 20)}pt`;
    const jc = attr(child(tblPr, 'w:jc'), 'w:val');
    const indent = Number(attr(child(tblPr, 'w:tblInd'), 'w:w') ?? 0) / 20;
    const align = jc === 'center' ? 'margin-left:auto;margin-right:auto' : jc === 'right' || jc === 'end' ? 'margin-left:auto' : indent ? `margin-left:${f(indent)}pt` : '';

    let html = `<table style="border-collapse:collapse;table-layout:fixed;${widthCss};${align}">`;
    if (grid.length > 0) html += `<colgroup>${grid.map((w) => `<col style="width:${f(w)}pt">`).join('')}</colgroup>`;

    for (const [r, row] of rows.entries()) {
      const cells = matrix[r] as Cell[];
      const trHeight = Number(attr(child(child(row, 'w:trPr'), 'w:trHeight'), 'w:val') ?? 0) / 20;
      html += `<tr${trHeight > 0 ? ` style="height:${f(trHeight)}pt"` : ''}>`;
      const isFirstRow = r === 0;
      const isLastRow = r === rows.length - 1;
      const bodyIndex = r - (firstRow ? 1 : 0);
      for (const cell of cells) {
        if (cell.hidden) continue;
        const tcPr = child(cell.node, 'w:tcPr');
        const isFirstCol = cell.col === 0;
        const isLastCol = cell.col + cell.span >= totalCols;

        // Conditional formatting from the table style, weakest to strongest.
        const parts: TableConditional[] = [];
        const add = (name: string) => { const c = style.conditionals.get(name); if (c) parts.push(c); };
        if (bandRows && !(firstRow && isFirstRow) && !(lastRow && isLastRow)) add(bodyIndex % 2 === 0 ? 'band1Horz' : 'band2Horz');
        if (firstCol && isFirstCol) add('firstCol');
        if (lastCol && isLastCol) add('lastCol');
        if (firstRow && isFirstRow) add('firstRow');
        if (lastRow && isLastRow) add('lastRow');
        const cond = {
          p: mergeP(...parts.map((c) => c.p)),
          r: mergeR(...parts.map((c) => c.r)),
          shd: [...parts].reverse().find((c) => c.shd)?.shd,
          borders: Object.assign({}, ...parts.map((c) => c.borders ?? {})) as Borders,
        };

        const own = readBorders(child(tcPr, 'w:tcBorders'), theme) ?? {};
        const pick = (own1: Border | undefined, condB: Border | undefined, table: Border | undefined): Border | undefined => own1 ?? condB ?? table;
        const lastRowOfCell = r + cell.rowSpan - 1 >= rows.length - 1;
        const sides: Record<'top' | 'right' | 'bottom' | 'left', Border | undefined> = {
          top: pick(own.top, cond.borders.top, isFirstRow ? tableBorders.top : tableBorders.insideH),
          bottom: pick(own.bottom, cond.borders.bottom, lastRowOfCell ? tableBorders.bottom : tableBorders.insideH),
          left: pick(own.left, cond.borders.left, isFirstCol ? tableBorders.left : tableBorders.insideV),
          right: pick(own.right, cond.borders.right, isLastCol ? tableBorders.right : tableBorders.insideV),
        };
        const css: string[] = [];
        const w = children(tcPr, 'w:tcW')[0];
        const wt = attr(w, 'w:type');
        const wv = Number(attr(w, 'w:w') ?? 0);
        if (grid.length === 0 && wt === 'dxa' && wv > 0) css.push(`width:${f(wv / 20)}pt`);
        css.push(`padding:${f(cellMar.top)}pt ${f(cellMar.right)}pt ${f(cellMar.bottom)}pt ${f(cellMar.left)}pt`);
        for (const side of ['top', 'right', 'bottom', 'left'] as const) {
          const b = borderCss(sides[side]);
          if (b) css.push(`border-${side}:${b}`);
        }
        const fill = shading(tcPr, theme) ?? cond.shd;
        if (fill) css.push(`background-color:${fill}`);
        const va = attr(child(tcPr, 'w:vAlign'), 'w:val');
        css.push(`vertical-align:${va === 'center' ? 'middle' : va === 'bottom' ? 'bottom' : 'top'}`);

        const inner = this.blocks(kids(cell.node), 1 + this.depthGuard(depth), {
          p: mergeP(outerTable?.p, style.p, cond.p),
          r: mergeR(outerTable?.r, style.r, cond.r),
        });
        html += `<td${cell.span > 1 ? ` colspan="${cell.span}"` : ''}${cell.rowSpan > 1 ? ` rowspan="${cell.rowSpan}"` : ''} style="${css.join(';')}">${inner || '&#8203;'}</td>`;
      }
      html += '</tr>';
    }
    html += '</table>\n';
    return html;
  }

  private depthGuard(depth: number): number {
    return Math.min(depth, MAX_DEPTH);
  }
}

export function safeHref(target: string): string | undefined {
  return /^(https?:|mailto:)/i.test(target) ? target : undefined;
}
