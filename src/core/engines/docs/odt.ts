import { XMLParser } from 'fast-xml-parser';
import { MorphError } from '../../../shared/errors';
import { escapeHtml, type PageSpec } from './html';
import { fontStack, naturalLineHeight } from './docx/fonts';
import { assertSafeZip, readZipEntry } from './zipguard';

type XmlNode = Record<string, unknown>;

const MAX_XML_BYTES = 200 * 1024 * 1024;
const MAX_IMAGE_BYTES = 30 * 1024 * 1024;
const MAX_DEPTH = 60;
const IMAGE_MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', bmp: 'image/bmp', webp: 'image/webp' };

interface TextStyle {
  family?: string;
  parent?: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  align?: 'left' | 'center' | 'right' | 'justify';
  pageBreakBefore?: boolean;
  sizePt?: number;
  color?: string;
  background?: string;
  fontName?: string;
  marginTop?: number;
  marginBottom?: number;
  marginLeft?: number;
  marginRight?: number;
  textIndent?: number;
  lineHeight?: string;
}

const toPt = (value: string | undefined): number | undefined => {
  if (!value) return undefined;
  const m = /^(-?[\d.]+)(pt|cm|mm|in|px)$/.exec(value.trim());
  if (!m) return undefined;
  const n = Number(m[1]);
  const unit = m[2];
  if (!Number.isFinite(n)) return undefined;
  return unit === 'pt' ? n : unit === 'cm' ? (n / 2.54) * 72 : unit === 'mm' ? (n / 25.4) * 72 : unit === 'in' ? n * 72 : n * 0.75;
};

const attrsOf = (node: XmlNode): Record<string, string> => (node[':@'] as Record<string, string> | undefined) ?? {};
const tagOf = (node: XmlNode): string => Object.keys(node).find((k) => k !== ':@') ?? '';
const childrenOf = (node: XmlNode): XmlNode[] => {
  const value = node[tagOf(node)];
  return Array.isArray(value) ? (value as XmlNode[]) : [];
};

function collectStyles(nodes: XmlNode[], into: Map<string, TextStyle>, fonts: Map<string, string>): void {
  for (const node of nodes) {
    const tag = tagOf(node);
    if (tag === 'style:font-face') {
      const a = attrsOf(node);
      const name = a['@_style:name'];
      const family = a['@_svg:font-family'];
      if (name && family) fonts.set(name, family.replace(/^'|'$/g, ''));
    }
    if (tag === 'style:style' || tag === 'style:default-style') {
      const a0 = attrsOf(node);
      const name = tag === 'style:default-style' ? `default:${a0['@_style:family'] ?? 'paragraph'}` : a0['@_style:name'];
      if (name) {
        const style: TextStyle = {};
        if (a0['@_style:family']) style.family = a0['@_style:family'];
        if (a0['@_style:parent-style-name']) style.parent = a0['@_style:parent-style-name'];
        for (const child of childrenOf(node)) {
          const a = attrsOf(child);
          if (tagOf(child) === 'style:text-properties') {
            if (a['@_fo:font-weight'] === 'bold' || Number(a['@_fo:font-weight']) >= 600) style.bold = true;
            else if (a['@_fo:font-weight'] === 'normal') style.bold = false;
            if (a['@_fo:font-style'] === 'italic') style.italic = true;
            else if (a['@_fo:font-style'] === 'normal') style.italic = false;
            if (a['@_style:text-underline-style']) style.underline = a['@_style:text-underline-style'] !== 'none';
            if (a['@_style:text-line-through-style']) style.strike = a['@_style:text-line-through-style'] !== 'none';
            const size = toPt(a['@_fo:font-size']);
            if (size) style.sizePt = size;
            if (a['@_fo:color'] && /^#[0-9a-f]{6}$/i.test(a['@_fo:color'])) style.color = a['@_fo:color'];
            if (a['@_fo:background-color'] && /^#[0-9a-f]{6}$/i.test(a['@_fo:background-color'])) style.background = a['@_fo:background-color'];
            const fontName = a['@_style:font-name'] ?? a['@_fo:font-family'];
            if (fontName) style.fontName = fontName.replace(/^'|'$/g, '');
          }
          if (tagOf(child) === 'style:paragraph-properties') {
            const align = a['@_fo:text-align'];
            if (align === 'center') style.align = 'center';
            else if (align === 'end' || align === 'right') style.align = 'right';
            else if (align === 'justify') style.align = 'justify';
            else if (align === 'start' || align === 'left') style.align = 'left';
            if (a['@_fo:break-before'] === 'page') style.pageBreakBefore = true;
            const mt = toPt(a['@_fo:margin-top']); if (mt !== undefined) style.marginTop = mt;
            const mb = toPt(a['@_fo:margin-bottom']); if (mb !== undefined) style.marginBottom = mb;
            const ml = toPt(a['@_fo:margin-left']); if (ml !== undefined) style.marginLeft = ml;
            const mr = toPt(a['@_fo:margin-right']); if (mr !== undefined) style.marginRight = mr;
            const ti = toPt(a['@_fo:text-indent']); if (ti !== undefined) style.textIndent = ti;
            if (a['@_fo:line-height'] && /^\d+(\.\d+)?%$/.test(a['@_fo:line-height'])) style.lineHeight = a['@_fo:line-height'];
          }
        }
        into.set(name, style);
      }
    } else {
      collectStyles(childrenOf(node), into, fonts);
    }
  }
}

/** Effective style: default for the family, then the parent chain, then the style itself. */
function resolve(ctx: { styles: Map<string, TextStyle>; fonts: Map<string, string> }, name: string | undefined, family: 'paragraph' | 'text'): TextStyle {
  const chain: TextStyle[] = [];
  const seen = new Set<string>();
  let current = name ? ctx.styles.get(name) : undefined;
  while (current && chain.length < 20) {
    chain.unshift(current);
    const parent = current.parent;
    if (!parent || seen.has(parent)) break;
    seen.add(parent);
    current = ctx.styles.get(parent);
  }
  const base = ctx.styles.get(`default:${family}`);
  const merged: TextStyle = {};
  for (const part of [base, ...chain]) if (part) Object.assign(merged, Object.fromEntries(Object.entries(part).filter(([k, v]) => v !== undefined && k !== 'parent' && k !== 'family')));
  return merged;
}

const fontCss = (ctx: { fonts: Map<string, string> }, style: TextStyle): string | undefined => {
  if (!style.fontName) return undefined;
  const family = ctx.fonts.get(style.fontName) ?? style.fontName;
  const generic = /times|georgia|cambria|garamond|palatino|serif$/i.test(family) && !/sans/i.test(family) ? 'serif' : /courier|consolas|mono/i.test(family) ? 'monospace' : 'sans-serif';
  return `font-family:${fontStack(family.replace(/['"<>&\\]/g, ''))}`.replace(/, (serif|sans-serif|monospace)$/, `, ${generic}`);
};

const textCss = (ctx: { fonts: Map<string, string> }, s: TextStyle, base?: TextStyle): string => {
  const css: string[] = [];
  const font = fontCss(ctx, s);
  if (font && s.fontName !== base?.fontName) css.push(font);
  if (s.sizePt && s.sizePt !== base?.sizePt) css.push(`font-size:${s.sizePt}pt`);
  if (s.bold !== undefined && s.bold !== base?.bold) css.push(`font-weight:${s.bold ? 'bold' : 'normal'}`);
  if (s.italic !== undefined && s.italic !== base?.italic) css.push(`font-style:${s.italic ? 'italic' : 'normal'}`);
  if (s.underline !== base?.underline || s.strike !== base?.strike) {
    const deco = [s.underline ? 'underline' : '', s.strike ? 'line-through' : ''].filter(Boolean).join(' ');
    if (deco || base?.underline || base?.strike) css.push(`text-decoration:${deco || 'none'}`);
  }
  if (s.color && s.color !== base?.color) css.push(`color:${s.color}`);
  if (s.background && s.background !== base?.background) css.push(`background-color:${s.background}`);
  return css.join(';');
};

interface Context {
  styles: Map<string, TextStyle>;
  fonts: Map<string, string>;
  images: Map<string, string>;
  warnings: Set<string>;
}

function inline(nodes: XmlNode[], ctx: Context, depth: number, base: TextStyle): string {
  if (depth > MAX_DEPTH) return '';
  let out = '';
  for (const node of nodes) {
    if ('#text' in node) {
      out += escapeHtml(String(node['#text']));
      continue;
    }
    const tag = tagOf(node);
    const a = attrsOf(node);
    switch (tag) {
      case 'text:span': {
        const style = { ...base, ...resolve(ctx, a['@_text:style-name'], 'text') };
        const css = textCss(ctx, style, base);
        const inner = inline(childrenOf(node), ctx, depth + 1, style);
        out += css ? `<span style="${css}">${inner}</span>` : inner;
        break;
      }
      case 'text:a': {
        const href = a['@_xlink:href'];
        const inner = inline(childrenOf(node), ctx, depth + 1, base);
        out += href && /^(https?:|mailto:)/i.test(href) ? `<a href="${escapeHtml(href)}">${inner}</a>` : inner;
        break;
      }
      case 'text:s':
        out += '&nbsp;'.repeat(Math.min(200, Number(a['@_text:c'] ?? 1) || 1));
        break;
      case 'text:tab':
        out += '<span style="display:inline-block;width:36pt"></span>';
        break;
      case 'text:line-break':
        out += '<br>';
        break;
      case 'draw:frame':
      case 'draw:a':
        out += inline(childrenOf(node), ctx, depth + 1, base);
        break;
      case 'draw:image': {
        const href = a['@_xlink:href'];
        const data = href ? ctx.images.get(href) : undefined;
        if (data) {
          const frame = a['@_svg:width'];
          out += `<img src="${data}" alt="" style="max-width:100%">`;
          void frame;
        } else ctx.warnings.add('Some pictures in this document could not be included.');
        break;
      }
      case 'text:note':
      case 'office:annotation':
      case 'text:bookmark':
      case 'text:bookmark-start':
      case 'text:bookmark-end':
      case 'text:soft-page-break':
      case 'text:sequence-decls':
        break;
      default:
        out += inline(childrenOf(node), ctx, depth + 1, base);
    }
  }
  return out;
}

function paragraphCss(ctx: Context, style: TextStyle): string {
  const css: string[] = [];
  const text = textCss(ctx, style);
  if (text) css.push(text);
  if (style.align) css.push(`text-align:${style.align}`);
  css.push(`padding-top:${style.marginTop ?? 0}pt`, `padding-bottom:${style.marginBottom ?? 0}pt`);
  if (style.marginLeft) css.push(`margin-left:${style.marginLeft}pt`);
  if (style.marginRight) css.push(`margin-right:${style.marginRight}pt`);
  if (style.textIndent) css.push(`text-indent:${style.textIndent}pt`);
  const lh = style.lineHeight ? Number(style.lineHeight.replace('%', '')) / 100 : 1;
  css.push(`line-height:${Math.round(lh * naturalLineHeight(style.fontName ? (ctx.fonts.get(style.fontName) ?? style.fontName) : undefined) * 100) / 100}`);
  if (style.pageBreakBefore) css.push('break-before:page');
  return css.join(';');
}

function block(nodes: XmlNode[], ctx: Context, depth: number): string {
  if (depth > MAX_DEPTH) return '';
  let out = '';
  for (const node of nodes) {
    const tag = tagOf(node);
    const a = attrsOf(node);
    switch (tag) {
      case 'text:p': {
        const style = resolve(ctx, a['@_text:style-name'], 'paragraph');
        const inner = inline(childrenOf(node), ctx, depth + 1, style);
        out += `<p style="${paragraphCss(ctx, style)}">${inner === '' ? '&#8203;' : inner}</p>\n`;
        break;
      }
      case 'text:h': {
        const style = resolve(ctx, a['@_text:style-name'], 'paragraph');
        const inner = inline(childrenOf(node), ctx, depth + 1, style);
        out += `<p style="${paragraphCss(ctx, style)}">${inner === '' ? '&#8203;' : inner}</p>\n`;
        break;
      }
      case 'text:list': {
        const ordered = ctx.styles.get(`list:${a['@_text:style-name'] ?? ''}`)?.family === 'number';
        const items = childrenOf(node)
          .filter((c) => tagOf(c) === 'text:list-item' || tagOf(c) === 'text:list-header')
          .map((item) => `<li>${block(childrenOf(item), ctx, depth + 1)}</li>`)
          .join('');
        out += ordered ? `<ol style="margin:0 0 0 18pt;padding:0 0 0 18pt">${items}</ol>\n` : `<ul style="margin:0 0 0 18pt;padding:0 0 0 18pt">${items}</ul>\n`;
        break;
      }
      case 'table:table': {
        let rows = '';
        for (const row of childrenOf(node)) {
          const rowTag = tagOf(row);
          const rowNodes = rowTag === 'table:table-header-rows' || rowTag === 'table:table-row-group' ? childrenOf(row) : [row];
          for (const r of rowNodes) {
            if (tagOf(r) !== 'table:table-row') continue;
            const cells = childrenOf(r)
              .filter((c) => tagOf(c) === 'table:table-cell')
              .map((cell) => {
                const ca = attrsOf(cell);
                const span = Number(ca['@_table:number-columns-spanned'] ?? 1);
                const rspan = Number(ca['@_table:number-rows-spanned'] ?? 1);
                return `<td${span > 1 ? ` colspan="${span}"` : ''}${rspan > 1 ? ` rowspan="${rspan}"` : ''} style="border:0.5pt solid #888;padding:2pt 5pt;vertical-align:top">${block(childrenOf(cell), ctx, depth + 1)}</td>`;
              })
              .join('');
            rows += `<tr>${cells}</tr>`;
          }
        }
        out += `<table style="border-collapse:collapse;margin:0 0 6pt">${rows}</table>\n`;
        break;
      }
      case 'text:table-of-content':
      case 'text:index-body':
      case 'text:section':
      case 'office:text':
      case 'office:body':
      case 'office:document-content':
      case 'text:table-of-content-source':
        out += tag === 'text:table-of-content-source' ? '' : block(childrenOf(node), ctx, depth + 1);
        break;
      case 'text:index-title':
        out += block(childrenOf(node), ctx, depth + 1);
        break;
      default:
        break;
    }
  }
  return out;
}

export interface OdtResult {
  html: string;
  warnings: string[];
  page: PageSpec | null;
}

function readPage(styleNodes: XmlNode[]): PageSpec | null {
  let found: PageSpec | null = null;
  const walk = (nodes: XmlNode[]): void => {
    for (const n of nodes) {
      if (found) return;
      if (tagOf(n) === 'style:page-layout-properties') {
        const a = attrsOf(n);
        const w = toPt(a['@_fo:page-width']);
        const h = toPt(a['@_fo:page-height']);
        if (w && h && w > 100 && h > 100 && w < 5000 && h < 5000) {
          const m = (k: string, d: number): number => Math.max(0, toPt(a[k]) ?? d);
          const spec: PageSpec = { widthPt: w, heightPt: h, top: m('@_fo:margin-top', 72), right: m('@_fo:margin-right', 72), bottom: m('@_fo:margin-bottom', 72), left: m('@_fo:margin-left', 72) };
          found = spec.left + spec.right > w - 36 || spec.top + spec.bottom > h - 36 ? { ...spec, top: 72, right: 72, bottom: 72, left: 72 } : spec;
          return;
        }
      }
      walk(childrenOf(n));
    }
  };
  walk(styleNodes);
  return found;
}

export async function odtToHtml(filePath: string): Promise<OdtResult> {
  await assertSafeZip(filePath);
  const xml = await readZipEntry(filePath, 'content.xml', MAX_XML_BYTES);
  if (!xml) throw new MorphError('CORRUPT_INPUT', 'The ODT file has no readable content.');
  const stylesXml = await readZipEntry(filePath, 'styles.xml', MAX_XML_BYTES);

  const parser = new XMLParser({ preserveOrder: true, ignoreAttributes: false, trimValues: false, parseTagValue: false, parseAttributeValue: false, processEntities: true, ignoreDeclaration: true });
  let content: XmlNode[];
  let stylesDoc: XmlNode[] = [];
  const styles = new Map<string, TextStyle>();
  const fonts = new Map<string, string>();
  try {
    if (stylesXml) {
      stylesDoc = parser.parse(stylesXml.toString('utf8')) as XmlNode[];
      collectStyles(stylesDoc, styles, fonts);
    }
    content = parser.parse(xml.toString('utf8')) as XmlNode[];
  } catch (error) {
    throw new MorphError('CORRUPT_INPUT', 'The ODT file could not be read. It may be damaged.', { detail: String(error) });
  }
  collectStyles(content, styles, fonts);

  // List styles: remember which ones are numbered.
  const markLists = (nodes: XmlNode[]): void => {
    for (const n of nodes) {
      if (tagOf(n) === 'text:list-style') {
        const name = attrsOf(n)['@_style:name'];
        const first = childrenOf(n)[0];
        if (name && first) styles.set(`list:${name}`, { family: tagOf(first) === 'text:list-level-style-number' ? 'number' : 'bullet' });
      }
      markLists(childrenOf(n));
    }
  };
  markLists(stylesDoc);
  markLists(content);

  // Pictures referenced by the document, as data URIs (never external references).
  const images = new Map<string, string>();
  const refs = new Set<string>();
  const findImages = (nodes: XmlNode[]): void => {
    for (const n of nodes) {
      if (tagOf(n) === 'draw:image') {
        const href = attrsOf(n)['@_xlink:href'];
        if (href && !/^[a-z]+:/i.test(href)) refs.add(href);
      }
      findImages(childrenOf(n));
    }
  };
  findImages(content);
  for (const ref of [...refs].slice(0, 500)) {
    const ext = ref.split('.').pop()?.toLowerCase() ?? '';
    const mime = IMAGE_MIME[ext];
    if (!mime) continue;
    const data = await readZipEntry(filePath, ref.replace(/^\.\//, ''), MAX_IMAGE_BYTES).catch(() => null);
    if (data) images.set(ref, `data:${mime};base64,${data.toString('base64')}`);
  }

  const ctx: Context = { styles, fonts, images, warnings: new Set() };
  const html = block(content, ctx, 0);
  return { html, warnings: [...ctx.warnings], page: readPage(stylesDoc) };
}
