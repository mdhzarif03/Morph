import path from 'node:path';
import { MorphError } from '../../../../shared/errors';
import type { PageSpec } from '../html';
import { assertSafeZip, readZipEntry } from '../zipguard';
import { parseNumbering, parseStyles, parseTheme } from './model';
import { Renderer, type Relationship } from './render';
import { attr, child, children, findDeep, kids, parseXml, rootOf, tagOf, type XNode } from './xml';

export interface DocxHtml {
  body: string;
  warnings: string[];
  page: PageSpec | null;
}

const MAX_XML_BYTES = 200 * 1024 * 1024;
const MAX_IMAGE_BYTES = 30 * 1024 * 1024;
const MAX_TOTAL_IMAGE_BYTES = 200 * 1024 * 1024;
const MAX_IMAGES = 1000;
const IMAGE_MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', jpe: 'image/jpeg', gif: 'image/gif', bmp: 'image/bmp', webp: 'image/webp' };

async function readXml(file: string, name: string, required: boolean): Promise<XNode[] | null> {
  const data = await readZipEntry(file, name, MAX_XML_BYTES);
  if (!data) {
    if (required) throw new MorphError('CORRUPT_INPUT', 'The document has no readable content.');
    return null;
  }
  try {
    return parseXml(data.toString('utf8'));
  } catch (error) {
    throw new MorphError('CORRUPT_INPUT', 'The document could not be read. It may be damaged.', { detail: String(error) });
  }
}

function parseRels(root: XNode[] | null): Map<string, Relationship> {
  const rels = new Map<string, Relationship>();
  const top = root ? rootOf(root, 'Relationships') : undefined;
  for (const r of children(top, 'Relationship')) {
    const id = attr(r, 'Id');
    const target = attr(r, 'Target');
    if (id && target) rels.set(id, { target, external: attr(r, 'TargetMode') === 'External', type: attr(r, 'Type') ?? '' });
  }
  return rels;
}

function pageFrom(sectPr: XNode | undefined): PageSpec | null {
  const size = child(sectPr, 'w:pgSz');
  const mar = child(sectPr, 'w:pgMar');
  if (!size) return null;
  let w = Number(attr(size, 'w:w')) / 20;
  let h = Number(attr(size, 'w:h')) / 20;
  if (!Number.isFinite(w) || !Number.isFinite(h) || w < 100 || h < 100 || w > 5000 || h > 5000) return null;
  if (attr(size, 'w:orient') === 'landscape' && w < h) [w, h] = [h, w];
  const m = (name: string, fallback: number): number => {
    const v = Number(attr(mar, name));
    return Number.isFinite(v) && attr(mar, name) !== undefined ? Math.max(0, v / 20) : fallback;
  };
  const spec: PageSpec = { widthPt: w, heightPt: h, top: m('w:top', 72), right: m('w:right', 72), bottom: m('w:bottom', 72), left: m('w:left', 72) };
  // Keep a usable text area even for broken margin values.
  if (spec.left + spec.right > w - 36 || spec.top + spec.bottom > h - 36) return { ...spec, top: 72, right: 72, bottom: 72, left: 72 };
  return spec;
}

/** DOCX -> HTML that carries the document's own fonts, sizes, colours, spacing, lists, tables, pictures and page setup. */
export async function docxToHtml(filePath: string): Promise<DocxHtml> {
  await assertSafeZip(filePath);
  const document = await readXml(filePath, 'word/document.xml', true);
  const docRoot = document ? rootOf(document, 'w:document') : undefined;
  const body = child(docRoot, 'w:body');
  if (!body) throw new MorphError('CORRUPT_INPUT', 'This file is not a valid Word document.');

  const [stylesXml, numberingXml, themeXml, relsXml] = await Promise.all([
    readXml(filePath, 'word/styles.xml', false),
    readXml(filePath, 'word/numbering.xml', false),
    readXml(filePath, 'word/theme/theme1.xml', false),
    readXml(filePath, 'word/_rels/document.xml.rels', false),
  ]);
  const theme = parseTheme(themeXml);
  const styles = parseStyles(stylesXml, theme);
  const numbering = parseNumbering(numberingXml, theme);
  const rels = parseRels(relsXml);

  // Pictures are read up front (the renderer is synchronous) and embedded as data URIs.
  const wanted = new Set<string>();
  const collect = (nodes: XNode[], depth: number): void => {
    if (depth > 60) return;
    for (const n of nodes) {
      if (tagOf(n) === 'a:blip') {
        const id = attr(n, 'r:embed');
        if (id) wanted.add(id);
      }
      collect(kids(n), depth + 1);
    }
  };
  collect(kids(body), 0);
  const images = new Map<string, string>();
  let total = 0;
  for (const id of [...wanted].slice(0, MAX_IMAGES)) {
    const rel = rels.get(id);
    if (!rel || rel.external) continue;
    const ext = rel.target.split('.').pop()?.toLowerCase() ?? '';
    const mime = IMAGE_MIME[ext];
    if (!mime) continue;
    const entry = rel.target.startsWith('/') ? rel.target.slice(1) : path.posix.normalize(`word/${rel.target}`);
    const data = await readZipEntry(filePath, entry, MAX_IMAGE_BYTES).catch(() => null);
    if (!data) continue;
    total += data.length;
    if (total > MAX_TOTAL_IMAGE_BYTES) break;
    images.set(id, `data:${mime};base64,${data.toString('base64')}`);
  }

  const renderer = new Renderer({ theme, styles, numbering, rels, images });
  const html = renderer.blocks(kids(body));

  const sectPr = children(body, 'w:sectPr').at(-1);
  const cols = Number(attr(child(sectPr, 'w:cols'), 'w:num') ?? 1);
  if (cols > 1) renderer.warnings.add('This document uses several text columns; it is laid out in a single column.');
  if (findDeep(body, 'w:headerReference') || sectPr && (child(sectPr, 'w:headerReference') || child(sectPr, 'w:footerReference'))) {
    renderer.warnings.add('Headers and footers are not included.');
  }
  return { body: html, warnings: [...renderer.warnings], page: pageFrom(sectPr) };
}
