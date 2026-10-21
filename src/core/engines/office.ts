import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { MorphError } from '../../shared/errors';
import type { FormatId } from '../../shared/formats';
import { runProcess, tailLines } from '../proc';
import { requireToolPath } from '../tools';
import { renderPdfToImages } from './pdf';
import type { EngineContext, EngineResult } from './types';

const CONVERT_TIMEOUT_MS = 10 * 60_000;
const MAX_TEXT_BYTES = 100 * 1024 * 1024;

/** LibreOffice filter name for each target we ask it to write. */
const LO_TARGET: Partial<Record<FormatId, { filter: string; ext: string }>> = {
  pdf: { filter: 'pdf:writer_pdf_Export', ext: 'pdf' },
  docx: { filter: 'docx:MS Word 2007 XML', ext: 'docx' },
  odt: { filter: 'odt:writer8', ext: 'odt' },
};

/**
 * Prepares the input LibreOffice will read. We always hand it a private copy with a neutral name:
 * that keeps odd characters out of its command line and guarantees it never touches the original.
 * Plain text is normalised to UTF-8 (with BOM) so LibreOffice reads the right encoding.
 */
async function stageInput(ctx: EngineContext, inputDir: string): Promise<string> {
  const ext = ctx.sourceFormat === 'txt' ? 'txt' : ctx.sourceFormat === 'doc' ? 'doc' : ctx.sourceFormat === 'odt' ? 'odt' : 'docx';
  const staged = path.join(inputDir, `source.${ext}`);

  if (ctx.sourceFormat !== 'txt') {
    await fs.copyFile(ctx.sourcePath, staged);
    return staged;
  }

  const stat = await fs.stat(ctx.sourcePath);
  if (stat.size > MAX_TEXT_BYTES) {
    throw new MorphError('INPUT_TOO_LARGE', 'This text file is too large to convert to a document (limit 100 MB).');
  }
  const raw = await fs.readFile(ctx.sourcePath);
  let text: string;
  if (raw[0] === 0xff && raw[1] === 0xfe) text = new TextDecoder('utf-16le').decode(raw.subarray(2));
  else if (raw[0] === 0xfe && raw[1] === 0xff) text = new TextDecoder('utf-16be').decode(raw.subarray(2));
  else {
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(raw);
    } catch {
      text = new TextDecoder('windows-1252').decode(raw);
    }
  }
  text = text.replace(/^\uFEFF/, '');
  await fs.writeFile(staged, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, 'utf8')]));
  return staged;
}

/** Runs LibreOffice headless. Returns the path of the produced file. */
async function runLibreOffice(ctx: EngineContext, targetFormat: 'pdf' | 'docx' | 'odt', progressRange: [number, number]): Promise<string> {
  const soffice = requireToolPath(ctx.toolchain, 'soffice', 'converting documents');
  const target = LO_TARGET[targetFormat];
  if (!target) throw new MorphError('INTERNAL', `No LibreOffice filter for ${targetFormat}.`);

  const inputDir = path.join(ctx.workDir, 'lo-in');
  const outDir = path.join(ctx.workDir, 'lo-out');
  const profileDir = path.join(ctx.workDir, 'lo-profile');
  await Promise.all([fs.mkdir(inputDir, { recursive: true }), fs.mkdir(outDir, { recursive: true }), fs.mkdir(profileDir, { recursive: true })]);

  const input = await stageInput(ctx, inputDir);
  ctx.signal.throwIfAborted();
  ctx.report({ phase: 'Converting with LibreOffice', progress: progressRange[0] });

  const args = [
    '--headless',
    '--invisible',
    '--norestore',
    '--nolockcheck',
    '--nodefault',
    '--nologo',
    '--nofirststartwizard',
    `-env:UserInstallation=${pathToFileURL(profileDir).href}`,
    '--convert-to',
    target.filter,
    '--outdir',
    outDir,
    input,
  ];

  const env: NodeJS.ProcessEnv = { ...process.env, HOME: process.env.HOME ?? ctx.workDir };
  const result = await runProcess(soffice, args, { signal: ctx.signal, timeoutMs: CONVERT_TIMEOUT_MS, env, cwd: ctx.workDir });
  ctx.report({ progress: progressRange[1] });

  const produced = path.join(outDir, `source.${target.ext}`);
  const stat = await fs.stat(produced).catch(() => null);
  if (result.code !== 0 || !stat || stat.size === 0) {
    const detail = tailLines(`${result.stderr}\n${result.stdout}`);
    if (/password/i.test(detail)) {
      throw new MorphError('PASSWORD_PROTECTED', 'This document is password-protected. Remove the password and try again.', { detail });
    }
    if (/source file could not be loaded|general input\/output error|not.*valid/i.test(detail)) {
      throw new MorphError('CORRUPT_INPUT', 'The document could not be opened. It may be damaged or in an unsupported variant.', { detail });
    }
    throw new MorphError('TOOL_FAILED', 'LibreOffice could not convert this document.', { detail: detail || `exit code ${String(result.code)}` });
  }
  return produced;
}

export async function convertDocument(ctx: EngineContext): Promise<EngineResult> {
  const target = ctx.targetFormat;

  if (target === 'pdf' || target === 'docx' || target === 'odt') {
    const produced = await runLibreOffice(ctx, target, [0.05, 0.95]);
    const ext = target;
    if (target === 'pdf') {
      ctx.warn('Layout is reproduced by LibreOffice. Fonts that are not installed on this computer are substituted, so pagination can differ slightly from Microsoft Word.');
    } else if (ctx.sourceFormat !== 'txt') {
      ctx.warn('Complex formatting, tracked changes and some embedded objects may not survive conversion between word-processor formats.');
    }
    ctx.report({ progress: 1 });
    return { files: [{ path: produced, name: `${ctx.baseName}.${ext}` }], packaging: 'single' };
  }

  if (target === 'png' || target === 'jpg') {
    // Documents are rendered to PDF first, then each page is rasterised.
    const pdfPath = await runLibreOffice(ctx, 'pdf', [0.02, 0.4]);
    const scaled: EngineContext = {
      ...ctx,
      report(update) {
        const progress = update.progress === undefined ? undefined : update.progress === null ? null : 0.4 + update.progress * 0.6;
        ctx.report({ ...(update.phase ? { phase: update.phase } : {}), ...(progress !== undefined ? { progress } : {}) });
      },
    };
    ctx.warn('Pages are laid out by LibreOffice, so they can differ slightly from Microsoft Word where fonts are missing.');
    return renderPdfToImages(scaled, pdfPath, ctx.baseName);
  }

  throw new MorphError('UNSUPPORTED_FORMAT', 'That document conversion is not supported.');
}
