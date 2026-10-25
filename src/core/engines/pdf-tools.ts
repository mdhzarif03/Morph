import { promises as fs } from 'node:fs';
import path from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { MorphError } from '../../shared/errors';
import { parsePageRange } from './pdf';
import type { EngineContext, EngineResult, WorkFile } from './types';

/** One PDF taking part in a merge or split. `pages` are 1-based; null means every page. */
export interface PdfToolInput {
  path: string;
  name: string;
  pages: number[] | null;
}

export type PdfToolRequest =
  | { kind: 'merge'; inputs: PdfToolInput[] }
  | {
      kind: 'split';
      input: PdfToolInput;
      /**
       * extract: the chosen pages become one new PDF.
       * each:    every chosen page becomes its own PDF.
       * ranges:  every comma-separated group in `ranges` becomes its own PDF ("1-3, 4-6, 9-").
       * every:   the chosen pages are cut into parts of `every` pages.
       */
      mode: 'extract' | 'each' | 'ranges' | 'every';
      ranges?: string;
      every?: number;
    };

export const MAX_MERGE_FILES = 100;
const MAX_TOTAL_INPUT_BYTES = 1024 * 1024 * 1024;
const MAX_OUTPUT_PAGES = 10_000;
const MAX_PARTS = 2000;

async function loadPdf(file: PdfToolInput, ctx: EngineContext): Promise<{ doc: PDFDocument; pageCount: number }> {
  ctx.signal.throwIfAborted();
  const bytes = await fs.readFile(file.path);
  try {
    // pdf-lib refuses encrypted files unless told to ignore the encryption; Morph never unlocks documents.
    const doc = await PDFDocument.load(bytes, { ignoreEncryption: false, updateMetadata: false, throwOnInvalidObject: false });
    const pageCount = doc.getPageCount();
    if (pageCount < 1) throw new MorphError('CORRUPT_INPUT', `${file.name} has no readable pages.`);
    return { doc, pageCount };
  } catch (error) {
    if (error instanceof MorphError) throw error;
    const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    if (/encrypt/i.test(text)) throw new MorphError('PASSWORD_PROTECTED', `${file.name} is password-protected. Remove the password and try again.`, { detail: text });
    throw new MorphError('CORRUPT_INPUT', `${file.name} is damaged or not a valid PDF and could not be read.`, { detail: text });
  }
}

/** Zero-based page indexes from a 1-based selection, validated against the document. */
function indexesFor(file: PdfToolInput, pageCount: number): number[] {
  if (file.pages === null) return Array.from({ length: pageCount }, (_, i) => i);
  if (file.pages.length === 0) throw new MorphError('INVALID_OPTIONS', `No pages are selected in ${file.name}.`);
  const seen = new Set<number>();
  for (const page of file.pages) {
    if (!Number.isInteger(page) || page < 1 || page > pageCount) {
      throw new MorphError('INVALID_OPTIONS', `${file.name} has ${pageCount} page${pageCount === 1 ? '' : 's'}; page ${page} does not exist.`);
    }
    seen.add(page - 1);
  }
  return file.pages.filter((p, i, all) => all.indexOf(p) === i).map((p) => p - 1);
}

async function copyInto(target: PDFDocument, source: PDFDocument, indexes: number[]): Promise<void> {
  const pages = await target.copyPages(source, indexes);
  for (const page of pages) target.addPage(page);
}

async function save(doc: PDFDocument, file: string): Promise<void> {
  const bytes = await doc.save({ useObjectStreams: true });
  await fs.writeFile(file, bytes);
}

/** "1-3,5" style label used in output names. */
export function compactPages(pages: readonly number[]): string {
  const sorted = [...new Set(pages)].sort((a, b) => a - b);
  const parts: string[] = [];
  let i = 0;
  while (i < sorted.length) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === (sorted[j] ?? 0) + 1) j += 1;
    parts.push(i === j ? `${sorted[i]}` : `${sorted[i]}-${sorted[j]}`);
    i = j + 1;
  }
  const text = parts.join('_');
  return text.length > 40 ? `${text.slice(0, 40)}_etc` : text;
}

/** Splits "1-3, 4, 7-" into one page list per group. Groups may not be empty or out of range. */
export function parseRangeGroups(input: string, pageCount: number): number[][] {
  const groups = input
    .split(',')
    .map((g) => g.trim())
    .filter((g) => g !== '');
  if (groups.length === 0) throw new MorphError('INVALID_OPTIONS', 'Type the page ranges to split at, for example 1-3, 4-6, 7-.');
  if (groups.length > MAX_PARTS) throw new MorphError('INVALID_OPTIONS', `Too many parts. Use at most ${MAX_PARTS}.`);
  return groups.map((group) => parsePageRange(group, pageCount));
}

export async function runPdfTool(ctx: EngineContext, request: PdfToolRequest): Promise<EngineResult> {
  return request.kind === 'merge' ? merge(ctx, request.inputs) : split(ctx, request);
}

async function merge(ctx: EngineContext, inputs: PdfToolInput[]): Promise<EngineResult> {
  if (inputs.length < 2) throw new MorphError('INVALID_OPTIONS', 'Add at least two PDFs to merge.');
  if (inputs.length > MAX_MERGE_FILES) throw new MorphError('INVALID_OPTIONS', `You can merge up to ${MAX_MERGE_FILES} PDFs at once.`);

  let total = 0;
  for (const input of inputs) total += (await fs.stat(input.path)).size;
  if (total > MAX_TOTAL_INPUT_BYTES) throw new MorphError('INPUT_TOO_LARGE', 'These PDFs add up to more than 1 GB, which is more than Morph can merge at once.');

  const output = await PDFDocument.create();
  let pagesDone = 0;
  for (const [index, input] of inputs.entries()) {
    ctx.report({ phase: `Adding ${input.name} (${index + 1} of ${inputs.length})`, progress: index / inputs.length });
    const { doc, pageCount } = await loadPdf(input, ctx);
    const indexes = indexesFor(input, pageCount);
    pagesDone += indexes.length;
    if (pagesDone > MAX_OUTPUT_PAGES) throw new MorphError('INPUT_TOO_LARGE', `The merged PDF would have more than ${MAX_OUTPUT_PAGES.toLocaleString('en-US')} pages.`);
    await copyInto(output, doc, indexes);
  }
  if (pagesDone === 0) throw new MorphError('INVALID_OPTIONS', 'No pages are selected.');

  ctx.signal.throwIfAborted();
  ctx.report({ phase: 'Writing the merged PDF', progress: 0.95 });
  const file = path.join(ctx.workDir, 'merged.pdf');
  await save(output, file);
  ctx.warn('Bookmarks and form fields are not carried over to the merged PDF; the pages themselves are unchanged.');
  return { files: [{ path: file, name: `${ctx.baseName}.pdf` }], packaging: 'single' };
}

async function split(ctx: EngineContext, request: Extract<PdfToolRequest, { kind: 'split' }>): Promise<EngineResult> {
  ctx.report({ phase: 'Reading PDF', progress: null });
  const { doc, pageCount } = await loadPdf(request.input, ctx);
  const chosen = indexesFor(request.input, pageCount).map((i) => i + 1);

  let parts: number[][];
  switch (request.mode) {
    case 'extract':
      parts = [chosen];
      if (chosen.length === pageCount) ctx.warn('All pages were chosen, so the new PDF is a copy of the original.');
      break;
    case 'each':
      parts = chosen.map((p) => [p]);
      break;
    case 'ranges':
      parts = parseRangeGroups(request.ranges ?? '', pageCount);
      break;
    case 'every': {
      const size = Math.floor(request.every ?? 0);
      if (!Number.isFinite(size) || size < 1) throw new MorphError('INVALID_OPTIONS', 'Choose how many pages each part should have.');
      parts = [];
      for (let i = 0; i < chosen.length; i += size) parts.push(chosen.slice(i, i + size));
      break;
    }
  }
  if (parts.length === 0 || parts.every((p) => p.length === 0)) throw new MorphError('INVALID_OPTIONS', 'No pages are selected.');
  if (parts.length > MAX_PARTS) throw new MorphError('INVALID_OPTIONS', `That would create ${parts.length} files. Use at most ${MAX_PARTS}.`);

  const dir = path.join(ctx.workDir, 'parts');
  await fs.mkdir(dir, { recursive: true });
  const width = Math.max(3, String(parts.length).length);
  const files: WorkFile[] = [];
  for (const [index, pages] of parts.entries()) {
    ctx.signal.throwIfAborted();
    ctx.report({ phase: parts.length === 1 ? 'Writing the new PDF' : `Writing part ${index + 1} of ${parts.length}`, progress: index / parts.length });
    const output = await PDFDocument.create();
    await copyInto(output, doc, pages.map((p) => p - 1));
    const file = path.join(dir, `part-${index + 1}.pdf`);
    await save(output, file);
    let name: string;
    if (parts.length === 1) name = `${ctx.baseName}_pages_${compactPages(pages)}.pdf`;
    else if (request.mode === 'each') name = `${ctx.baseName}_page_${String(pages[0]).padStart(width, '0')}.pdf`;
    else name = `${ctx.baseName}_part_${String(index + 1).padStart(width, '0')}_pages_${compactPages(pages)}.pdf`;
    files.push({ path: file, name });
  }
  ctx.warn('Bookmarks and form fields are not carried over to the new PDF files; the pages themselves are unchanged.');
  return { files, packaging: files.length === 1 ? 'single' : 'zip' };
}
