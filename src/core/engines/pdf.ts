import { promises as fs } from 'node:fs';
import path from 'node:path';
import { MorphError } from '../../shared/errors';
import { optNumber, optString, type OptionSpec } from '../../shared/options';
import type { FileDetails } from '../../shared/types';
import { requireToolPath } from '../tools';
import { runProcess, tailLines } from '../proc';
import type { EngineContext, EngineResult, WorkFile } from './types';

export interface PdfInfo {
  pages: number;
  /** First page size in PDF points (1/72 inch). */
  widthPt: number;
  heightPt: number;
  encrypted: boolean;
}

/** Longest side Morph will render, in pixels. Prevents multi-gigabyte bitmaps from huge page sizes. */
const MAX_SIDE_PX = 12_000;
const MAX_PAGES = 5000;
const PAGE_TIMEOUT_MS = 5 * 60_000;

export const pdfImageOptionSpecs: OptionSpec[] = [
  {
    key: 'dpi',
    type: 'select',
    label: 'Resolution',
    default: '150',
    choices: [
      { value: '72', label: '72 DPI', description: 'Screen preview' },
      { value: '150', label: '150 DPI', description: 'Good for reading' },
      { value: '200', label: '200 DPI' },
      { value: '300', label: '300 DPI', description: 'Print quality' },
      { value: '600', label: '600 DPI', description: 'Very large files' },
    ],
  },
  { key: 'quality', type: 'range', label: 'JPG quality', min: 1, max: 100, step: 1, default: 90 },
  {
    key: 'pageRange',
    type: 'text',
    label: 'Pages',
    default: '',
    maxLength: 120,
    placeholder: 'All pages — or e.g. 1-3, 5, 8-',
    pattern: '^[0-9,\\-\\s]+$',
    patternHint: 'use numbers, commas and dashes, e.g. 1-3, 5, 8-',
    help: 'Leave empty to convert every page.',
  },
  {
    key: 'packaging',
    type: 'select',
    label: 'Output',
    default: 'auto',
    choices: [
      { value: 'auto', label: 'Automatic', description: 'One image for one page, a ZIP for several' },
      { value: 'zip', label: 'Always a ZIP' },
    ],
  },
];

export function pdfImageOptionsFor(target: 'png' | 'jpg'): OptionSpec[] {
  return pdfImageOptionSpecs.filter((spec) => target === 'jpg' || spec.key !== 'quality');
}

/**
 * Parses "1-3, 5, 8-" into a sorted, de-duplicated list of 1-based page numbers.
 * Throws a user-readable INVALID_OPTIONS error for malformed or out-of-range input.
 */
export function parsePageRange(input: string, pageCount: number): number[] {
  const text = input.trim();
  if (text === '') return Array.from({ length: pageCount }, (_, i) => i + 1);

  const pages = new Set<number>();
  for (const rawPart of text.split(',')) {
    const part = rawPart.trim();
    if (part === '') continue;
    const match = /^(\d+)?\s*(-)?\s*(\d+)?$/.exec(part);
    if (!match || (match[1] === undefined && match[3] === undefined)) {
      throw new MorphError('INVALID_OPTIONS', `"${part}" is not a valid page range. Use something like 1-3, 5, 8-.`);
    }
    const hasDash = match[2] !== undefined;
    const start = match[1] !== undefined ? Number(match[1]) : 1;
    const end = hasDash ? (match[3] !== undefined ? Number(match[3]) : pageCount) : start;
    if (match[1] === undefined && !hasDash) throw new MorphError('INVALID_OPTIONS', `"${part}" is not a valid page range.`);
    if (start < 1 || end < 1) throw new MorphError('INVALID_OPTIONS', 'Page numbers start at 1.');
    if (start > end) throw new MorphError('INVALID_OPTIONS', `"${part}" runs backwards. Write it as ${end}-${start}.`);
    if (start > pageCount) throw new MorphError('INVALID_OPTIONS', `The document has only ${pageCount} page${pageCount === 1 ? '' : 's'}; page ${start} does not exist.`);
    for (let p = start; p <= Math.min(end, pageCount); p += 1) pages.add(p);
  }
  if (pages.size === 0) throw new MorphError('INVALID_OPTIONS', 'No pages selected.');
  return [...pages].sort((a, b) => a - b);
}

/** Zero-padded page number wide enough for the whole document, with a minimum of three digits. */
export function pageLabel(page: number, pageCount: number): string {
  return String(page).padStart(Math.max(3, String(pageCount).length), '0');
}

export function parsePdfInfo(stdout: string): PdfInfo {
  const pagesMatch = /^Pages:\s+(\d+)/m.exec(stdout);
  if (!pagesMatch) throw new MorphError('CORRUPT_INPUT', 'The PDF has no readable pages.');
  const sizeMatch = /^Page\s+size:\s+([\d.]+)\s+x\s+([\d.]+)\s+pts/m.exec(stdout);
  const encrypted = /^Encrypted:\s+yes/m.test(stdout);
  return {
    pages: Number(pagesMatch[1]),
    widthPt: sizeMatch ? Number(sizeMatch[1]) : 612,
    heightPt: sizeMatch ? Number(sizeMatch[2]) : 792,
    encrypted,
  };
}

function classifyPopplerFailure(stderr: string): MorphError {
  const detail = tailLines(stderr);
  if (/incorrect password|password/i.test(stderr)) {
    return new MorphError('PASSWORD_PROTECTED', 'This PDF is password-protected. Remove the password and try again.', { detail });
  }
  if (/permission error|copying of text from this document is not allowed/i.test(stderr)) {
    return new MorphError('PASSWORD_PROTECTED', 'This PDF restricts how it may be processed.', { detail });
  }
  if (/syntax error|couldn't read|may not be a pdf|damaged|xref|trailer/i.test(stderr)) {
    return new MorphError('CORRUPT_INPUT', 'The PDF is damaged and could not be read.', { detail });
  }
  return new MorphError('TOOL_FAILED', 'The PDF renderer reported an error.', { detail });
}

export async function readPdfInfo(pdfinfoPath: string, pdfPath: string, signal?: AbortSignal): Promise<PdfInfo> {
  const result = await runProcess(pdfinfoPath, [pdfPath], { timeoutMs: 60_000, ...(signal ? { signal } : {}) });
  if (result.code !== 0) throw classifyPopplerFailure(result.stderr);
  return parsePdfInfo(result.stdout);
}

export async function inspectPdf(pdfinfoPath: string | undefined, pdfPath: string): Promise<FileDetails> {
  if (!pdfinfoPath) return {};
  try {
    const info = await readPdfInfo(pdfinfoPath, pdfPath);
    return { pages: info.pages, width: Math.round(info.widthPt), height: Math.round(info.heightPt) };
  } catch (error) {
    if (error instanceof MorphError && (error.code === 'PASSWORD_PROTECTED' || error.code === 'CORRUPT_INPUT')) throw error;
    return {};
  }
}

/** Renders PDF pages to PNG/JPG, one Poppler process per page so progress and cancellation are precise. */
export async function renderPdfToImages(ctx: EngineContext, pdfPath: string, nameBase: string): Promise<EngineResult> {
  const target = ctx.targetFormat;
  if (target !== 'png' && target !== 'jpg') throw new MorphError('INTERNAL', 'PDF rendering supports PNG and JPG only.');

  const pdftoppm = requireToolPath(ctx.toolchain, 'pdftoppm', 'rendering PDF pages');
  const pdfinfo = requireToolPath(ctx.toolchain, 'pdfinfo', 'reading PDF pages');

  ctx.report({ phase: 'Reading PDF', progress: null });
  const info = await readPdfInfo(pdfinfo, pdfPath, ctx.signal);
  if (info.encrypted) ctx.warn('This PDF is encrypted but allows viewing, so it was rendered normally.');
  if (info.pages > MAX_PAGES) {
    throw new MorphError('INPUT_TOO_LARGE', `This PDF has ${info.pages.toLocaleString('en-US')} pages, more than the ${MAX_PAGES.toLocaleString('en-US')} Morph can render at once. Choose a page range.`);
  }

  const pages = parsePageRange(optString(ctx.options, 'pageRange'), info.pages);
  let dpi = Number(optString(ctx.options, 'dpi'));
  const longestPt = Math.max(info.widthPt, info.heightPt);
  const projected = (longestPt / 72) * dpi;
  if (projected > MAX_SIDE_PX) {
    const reduced = Math.max(36, Math.floor((MAX_SIDE_PX / longestPt) * 72));
    ctx.warn(`The pages are very large, so the resolution was lowered from ${dpi} to ${reduced} DPI to keep the images manageable.`);
    dpi = reduced;
  }

  const ext = target === 'jpg' ? 'jpg' : 'png';
  const pagesDir = path.join(ctx.workDir, 'pages');
  await fs.mkdir(pagesDir, { recursive: true });

  const files: WorkFile[] = [];
  const failures: number[] = [];
  let lastError: MorphError | null = null;

  for (const [index, page] of pages.entries()) {
    ctx.signal.throwIfAborted();
    ctx.report({ phase: `Rendering page ${page} of ${info.pages}`, progress: index / pages.length });

    const outBase = path.join(pagesDir, `p${page}`);
    const args = [target === 'jpg' ? '-jpeg' : '-png', '-r', String(dpi), '-f', String(page), '-l', String(page), '-singlefile'];
    if (target === 'jpg') args.push('-jpegopt', `quality=${optNumber(ctx.options, 'quality')}`);
    args.push(pdfPath, outBase);

    try {
      const result = await runProcess(pdftoppm, args, { signal: ctx.signal, timeoutMs: PAGE_TIMEOUT_MS });
      if (result.code !== 0) throw classifyPopplerFailure(result.stderr);
      const produced = `${outBase}.${ext}`;
      const stat = await fs.stat(produced).catch(() => null);
      if (!stat || stat.size === 0) throw new MorphError('TOOL_FAILED', `Page ${page} produced no image.`, { detail: tailLines(result.stderr) });
      const name = `${nameBase}_page_${pageLabel(page, info.pages)}.${ext}`;
      files.push({ path: produced, name });
    } catch (error) {
      if (error instanceof MorphError && (error.code === 'CANCELLED' || error.code === 'TOOL_MISSING' || error.code === 'PASSWORD_PROTECTED' || error.code === 'TIMEOUT')) throw error;
      // A damaged page should not discard the rest of the document.
      failures.push(page);
      lastError = error instanceof MorphError ? error : new MorphError('TOOL_FAILED', `Page ${page} could not be rendered.`);
      ctx.log.warn('page render failed', { page, error: String(error) });
    }
  }

  if (files.length === 0) throw lastError ?? new MorphError('TOOL_FAILED', 'No pages could be rendered.');
  if (failures.length > 0) {
    ctx.warn(`${failures.length} page${failures.length === 1 ? '' : 's'} could not be rendered and ${failures.length === 1 ? 'was' : 'were'} skipped (page${failures.length === 1 ? '' : 's'} ${failures.join(', ')}). The result contains the ${files.length} page${files.length === 1 ? '' : 's'} that rendered.`);
  }

  ctx.report({ progress: 1, phase: 'Rendered' });
  const forceZip = optString(ctx.options, 'packaging') === 'zip';
  const single = files.length === 1 && !forceZip;
  const onlyFile = files[0];
  if (single && onlyFile && info.pages === 1) {
    // A genuinely one-page document is named after the document itself (report.pdf -> report.png).
    // A single page picked out of a longer document keeps its page number.
    onlyFile.name = `${nameBase}.${ext}`;
  }
  return { files, packaging: single ? 'single' : 'zip' };
}
