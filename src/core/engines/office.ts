import { promises as fs } from 'node:fs';
import path from 'node:path';
import { MorphError } from '../../shared/errors';
import { optString, type OptionSpec } from '../../shared/options';
import { getHtmlPrinter } from '../print';
import { docxToHtml } from './docs/docx';
import { wrapHtml, type PageSize, type PageSpec } from './docs/html';
import { legacyDocToHtml } from './docs/legacy-doc';
import { odtToHtml } from './docs/odt';
import { txtToHtml } from './docs/txt';
import { renderPdfToImages } from './pdf';
import type { EngineContext, EngineResult } from './types';

export const documentPageOptionSpecs: OptionSpec[] = [
  {
    key: 'pageSize',
    type: 'select',
    label: 'Page size',
    default: 'auto',
    choices: [
      { value: 'auto', label: 'As in the document', description: 'DOCX keeps its own size; other files use A4' },
      { value: 'A4', label: 'A4' },
      { value: 'Letter', label: 'US Letter' },
    ],
  },
];

/** Builds the HTML for the source document. Everything runs inside Morph; no other program is involved. */
async function buildHtml(ctx: EngineContext): Promise<{ body: string; warnings: string[]; page: PageSpec | null; faithful: boolean }> {
  switch (ctx.sourceFormat) {
    case 'docx': {
      const result = await docxToHtml(ctx.sourcePath);
      return { body: result.body, warnings: result.warnings, page: result.page, faithful: true };
    }
    case 'odt': {
      const result = await odtToHtml(ctx.sourcePath);
      return { body: result.html, warnings: result.warnings, page: result.page, faithful: true };
    }
    case 'doc':
      return { page: null, faithful: false, body: await legacyDocToHtml(ctx.sourcePath), warnings: ['Legacy .doc files can only be read as text: formatting, tables and pictures are not included. Save the file as DOCX in Word for a faithful conversion.'] };
    case 'txt':
      return { body: await txtToHtml(ctx.sourcePath), warnings: [], page: null, faithful: false };
    default:
      throw new MorphError('UNSUPPORTED_FORMAT', 'That document type is not supported.');
  }
}

async function documentToPdf(ctx: EngineContext, progressRange: [number, number]): Promise<string> {
  const choice = optString(ctx.options, 'pageSize');
  const pageSize: PageSize = choice === 'Letter' ? 'Letter' : 'A4';
  const [from, to] = progressRange;

  ctx.report({ phase: 'Reading document', progress: from });
  const { body, warnings, page, faithful } = await buildHtml(ctx);
  for (const warning of warnings) ctx.warn(warning);
  ctx.signal.throwIfAborted();

  const htmlPath = path.join(ctx.workDir, 'document.html');
  const pdfPath = path.join(ctx.workDir, 'document.pdf');
  // 'auto' keeps the page setup stored in a DOCX; an explicit A4/Letter choice overrides it.
  const usePage = faithful && choice === 'auto' ? page : null;
  await fs.writeFile(htmlPath, wrapHtml(body, { variant: faithful ? 'faithful' : 'plain', pageSize, page: usePage }, ctx.baseName), 'utf8');

  ctx.report({ phase: 'Laying out pages', progress: from + (to - from) * 0.4 });
  await getHtmlPrinter()({ htmlPath, pdfPath, pageSize }, ctx.signal);
  ctx.signal.throwIfAborted();

  const stat = await fs.stat(pdfPath).catch(() => null);
  if (!stat || stat.size === 0) throw new MorphError('TOOL_FAILED', 'The document could not be turned into a PDF.');
  ctx.report({ progress: to });
  return pdfPath;
}

export async function convertDocument(ctx: EngineContext): Promise<EngineResult> {
  const target = ctx.targetFormat;

  if (target === 'pdf') {
    const pdfPath = await documentToPdf(ctx, [0.02, 0.95]);
    if (ctx.sourceFormat !== 'txt') ctx.warn('Pages are laid out by Morph, so line and page breaks can differ from Microsoft Word. Headers, footers, text boxes and exact fonts are not reproduced.');
    ctx.report({ progress: 1 });
    return { files: [{ path: pdfPath, name: `${ctx.baseName}.pdf` }], packaging: 'single' };
  }

  if (target === 'png' || target === 'jpg') {
    // Documents are laid out as a PDF first, then each page is rasterised.
    const pdfPath = await documentToPdf(ctx, [0.02, 0.4]);
    const scaled: EngineContext = {
      ...ctx,
      report(update) {
        const progress = update.progress === undefined ? undefined : update.progress === null ? null : 0.4 + update.progress * 0.6;
        ctx.report({ ...(update.phase ? { phase: update.phase } : {}), ...(progress !== undefined ? { progress } : {}) });
      },
    };
    if (ctx.sourceFormat !== 'txt') ctx.warn('Pages are laid out by Morph, so they can differ from Microsoft Word. Headers, footers, text boxes and exact fonts are not reproduced.');
    return renderPdfToImages(scaled, pdfPath, ctx.baseName);
  }

  throw new MorphError('UNSUPPORTED_FORMAT', 'That document conversion is not supported.');
}
