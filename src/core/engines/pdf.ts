import { promises as fs } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { PDFiumLibrary, type PDFiumDocument } from '@hyzyla/pdfium';
import { MorphError } from '../../shared/errors';
import { optNumber, optString, type OptionSpec } from '../../shared/options';
import type { FileDetails } from '../../shared/types';
import type { EngineContext, EngineResult, WorkFile } from './types';

export interface PdfInfo {
  pages: number;
  /** First page size in PDF points (1/72 inch). */
  widthPt: number;
  heightPt: number;
}

/** Longest side Morph will render, in pixels. Prevents multi-gigabyte bitmaps from huge page sizes. */
const MAX_SIDE_PX = 12_000;
const MAX_PAGES = 5000;
const MAX_PDF_BYTES = 1024 * 1024 * 1024;

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


// ---------------------------------------------------------------------------------------------
// PDFium (bundled WebAssembly build; no external program involved)

let libraryPromise: Promise<PDFiumLibrary> | null = null;
function getLibrary(): Promise<PDFiumLibrary> {
  libraryPromise ??= PDFiumLibrary.init().catch((error: unknown) => {
    libraryPromise = null;
    throw new MorphError('INTERNAL', 'The built-in PDF renderer could not start.', { detail: String(error) });
  });
  return libraryPromise;
}

function classifyPdfiumFailure(error: unknown): MorphError {
  const text = error instanceof Error ? error.message : String(error);
  if (/password/i.test(text)) return new MorphError('PASSWORD_PROTECTED', 'This PDF is password-protected. Remove the password and try again.', { detail: text });
  return new MorphError('CORRUPT_INPUT', 'The PDF is damaged or not a valid PDF and could not be read.', { detail: text });
}

async function openPdf(pdfPath: string): Promise<{ doc: PDFiumDocument; info: PdfInfo }> {
  const stat = await fs.stat(pdfPath);
  if (stat.size > MAX_PDF_BYTES) throw new MorphError('INPUT_TOO_LARGE', 'This PDF is larger than 1 GB, which is more than Morph can open.');
  const [library, bytes] = await Promise.all([getLibrary(), fs.readFile(pdfPath)]);
  let doc: PDFiumDocument;
  try {
    doc = await library.loadDocument(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  } catch (error) {
    throw classifyPdfiumFailure(error);
  }
  try {
    const pages = doc.getPageCount();
    if (pages < 1) throw new MorphError('CORRUPT_INPUT', 'The PDF has no readable pages.');
    const first = doc.getPage(0);
    const { originalWidth, originalHeight } = first.getOriginalSize();
    first.close();
    return { doc, info: { pages, widthPt: originalWidth, heightPt: originalHeight } };
  } catch (error) {
    doc.destroy();
    throw error instanceof MorphError ? error : classifyPdfiumFailure(error);
  }
}

export async function inspectPdf(pdfPath: string): Promise<FileDetails> {
  const { doc, info } = await openPdf(pdfPath);
  doc.destroy();
  return { pages: info.pages, width: Math.round(info.widthPt), height: Math.round(info.heightPt) };
}

/** Renders PDF pages to PNG/JPG with the bundled PDFium, one page at a time (precise progress and cancellation). */
export async function renderPdfToImages(ctx: EngineContext, pdfPath: string, nameBase: string): Promise<EngineResult> {
  const target = ctx.targetFormat;
  if (target !== 'png' && target !== 'jpg') throw new MorphError('INTERNAL', 'PDF rendering supports PNG and JPG only.');

  ctx.report({ phase: 'Reading PDF', progress: null });
  const { doc, info } = await openPdf(pdfPath);
  try {
    if (info.pages > MAX_PAGES) {
      throw new MorphError('INPUT_TOO_LARGE', `This PDF has ${info.pages.toLocaleString('en-US')} pages, more than the ${MAX_PAGES.toLocaleString('en-US')} Morph can render at once. Choose a page range.`);
    }
    const pages = parsePageRange(optString(ctx.options, 'pageRange'), info.pages);
    const requestedDpi = Number(optString(ctx.options, 'dpi'));
    const ext = target === 'jpg' ? 'jpg' : 'png';
    const pagesDir = path.join(ctx.workDir, 'pages');
    await fs.mkdir(pagesDir, { recursive: true });

    const files: WorkFile[] = [];
    const failures: number[] = [];
    let lastError: MorphError | null = null;
    let reduced = false;

    for (const [index, pageNumber] of pages.entries()) {
      ctx.signal.throwIfAborted();
      ctx.report({ phase: `Rendering page ${pageNumber} of ${info.pages}`, progress: index / pages.length });
      let page;
      try {
        page = doc.getPage(pageNumber - 1);
        const { originalWidth, originalHeight } = page.getOriginalSize();
        let dpi = requestedDpi;
        const longestPt = Math.max(originalWidth, originalHeight);
        if ((longestPt / 72) * dpi > MAX_SIDE_PX) {
          dpi = Math.max(36, Math.floor((MAX_SIDE_PX / longestPt) * 72));
          reduced = true;
        }
        const bitmap = await page.render({ scale: dpi / 72, render: 'bitmap', renderFormFields: true });
        const image = sharp(Buffer.from(bitmap.data.buffer, bitmap.data.byteOffset, bitmap.data.byteLength), {
          raw: { width: bitmap.width, height: bitmap.height, channels: 4 },
        }).flatten({ background: '#ffffff' });
        const out = path.join(pagesDir, `p${pageNumber}.${ext}`);
        if (target === 'jpg') await image.jpeg({ quality: optNumber(ctx.options, 'quality'), mozjpeg: false }).withMetadata({ density: dpi }).toFile(out);
        else await image.png({ compressionLevel: 6 }).withMetadata({ density: dpi }).toFile(out);
        files.push({ path: out, name: `${nameBase}_page_${pageLabel(pageNumber, info.pages)}.${ext}` });
      } catch (error) {
        if (error instanceof MorphError && error.code === 'CANCELLED') throw error;
        if (ctx.signal.aborted) throw error;
        failures.push(pageNumber);
        lastError = error instanceof MorphError ? error : new MorphError('TOOL_FAILED', `Page ${pageNumber} could not be rendered.`, { detail: String(error) });
        ctx.log.warn('page render failed', { page: pageNumber, error: String(error) });
      } finally {
        page?.close();
      }
    }

    if (reduced) ctx.warn('Some pages are very large, so their resolution was lowered to keep the images manageable.');
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
  } finally {
    doc.destroy();
  }
}

// ---------------------------------------------------------------------------------------------
// Page thumbnails for the merge / split preview

export interface PdfThumbnail {
  page: number;
  src: string;
  widthPt: number;
  heightPt: number;
}

/** An open document that renders small page previews on demand. Close it when done. */
export interface PdfPreviewSession {
  pageCount: number;
  thumbnails(start: number, count: number, targetWidthPx: number, signal?: AbortSignal): Promise<PdfThumbnail[]>;
  close(): void;
}

export async function openPdfPreview(pdfPath: string): Promise<PdfPreviewSession> {
  const { doc, info } = await openPdf(pdfPath);
  let closed = false;
  return {
    pageCount: info.pages,
    async thumbnails(start, count, targetWidthPx, signal) {
      if (closed) throw new MorphError('INTERNAL', 'The preview was closed.');
      const out: PdfThumbnail[] = [];
      const last = Math.min(info.pages, start + count);
      for (let index = Math.max(0, start); index < last; index += 1) {
        signal?.throwIfAborted();
        const page = doc.getPage(index);
        try {
          const { originalWidth, originalHeight } = page.getOriginalSize();
          const scale = Math.min(targetWidthPx / originalWidth, (targetWidthPx * 1.8) / originalHeight, 4);
          const bitmap = await page.render({ scale: Math.max(0.05, scale), render: 'bitmap', renderFormFields: true });
          const jpeg = await sharp(Buffer.from(bitmap.data.buffer, bitmap.data.byteOffset, bitmap.data.byteLength), { raw: { width: bitmap.width, height: bitmap.height, channels: 4 } })
            .flatten({ background: '#ffffff' })
            .jpeg({ quality: 68 })
            .toBuffer();
          out.push({ page: index + 1, src: `data:image/jpeg;base64,${jpeg.toString('base64')}`, widthPt: originalWidth, heightPt: originalHeight });
        } catch (error) {
          // One unreadable page must not hide the rest: send a blank placeholder with the page's proportions.
          if (signal?.aborted) throw error;
          out.push({ page: index + 1, src: '', widthPt: 595, heightPt: 842 });
        } finally {
          page.close();
        }
        // Let the main process breathe between pages so the popup stays responsive.
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      return out;
    },
    close() {
      if (closed) return;
      closed = true;
      doc.destroy();
    },
  };
}
