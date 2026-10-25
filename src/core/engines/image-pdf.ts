import { promises as fs } from 'node:fs';
import path from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { MorphError } from '../../shared/errors';
import { optString, type OptionSpec } from '../../shared/options';
import { loadImageSource, translateSharpError } from './image';
import type { EngineContext, EngineResult } from './types';

export const imagePdfOptionSpecs: OptionSpec[] = [
  {
    key: 'pageSize',
    type: 'select',
    label: 'Page size',
    default: 'a4',
    choices: [
      { value: 'a4', label: 'A4', description: 'Turns to landscape for wide images' },
      { value: 'letter', label: 'US Letter', description: 'Turns to landscape for wide images' },
      { value: 'image', label: 'Same as the image', description: 'The page is exactly as big as the picture' },
    ],
  },
  {
    key: 'margin',
    type: 'select',
    label: 'Margin',
    default: 'small',
    visibleWhen: { key: 'pageSize', equals: ['a4', 'letter'] },
    choices: [
      { value: 'none', label: 'None' },
      { value: 'small', label: 'Small', description: '0.25 inch' },
      { value: 'normal', label: 'Normal', description: '0.5 inch' },
    ],
  },
  {
    key: 'storage',
    type: 'select',
    label: 'Image quality in the PDF',
    default: 'auto',
    choices: [
      { value: 'auto', label: 'Automatic', description: 'JPEG files are kept as they are; other images stay lossless when small' },
      { value: 'lossless', label: 'Lossless', description: 'Larger file' },
      { value: 'jpeg', label: 'Smaller file', description: 'High-quality JPEG' },
    ],
  },
];

const PAGE_POINTS: Record<string, [number, number]> = { a4: [595.28, 841.89], letter: [612, 792] };
const MARGIN_POINTS: Record<string, number> = { none: 0, small: 18, normal: 36 };
const SMALL_IMAGE_PIXELS = 2_000_000;
const MAX_PAGE_POINTS = 14_400;

/** One picture on one PDF page. Everything is done inside Morph; transparent areas become white. */
export async function convertImageToPdf(ctx: EngineContext): Promise<EngineResult> {
  ctx.report({ phase: 'Reading image', progress: null });
  const source = await loadImageSource(ctx.sourcePath, ctx.sourceFormat);
  const { meta } = source;
  if (meta.pages > 1) ctx.warn(`The file has ${meta.pages} frames or pages. Only the first one was placed in the PDF.`);
  ctx.signal.throwIfAborted();

  const storage = optString(ctx.options, 'storage');
  const keepOriginalJpeg = ctx.sourceFormat === 'jpg' && storage !== 'lossless' && meta.orientation <= 1 && meta.space !== 'cmyk';

  let bytes: Uint8Array;
  let kind: 'jpg' | 'png';
  let width: number;
  let height: number;
  try {
    if (keepOriginalJpeg) {
      bytes = await fs.readFile(ctx.sourcePath);
      kind = 'jpg';
      width = meta.width;
      height = meta.height;
    } else {
      let pipeline = source.create(false);
      if (meta.orientation > 1) pipeline = pipeline.rotate();
      if (meta.space === 'cmyk') pipeline = pipeline.toColourspace('srgb');
      if (meta.hasAlpha) {
        pipeline = pipeline.flatten({ background: '#ffffff' });
        ctx.warn('Transparent areas were filled with white.');
      }
      const lossless = storage === 'lossless' || (storage === 'auto' && meta.width * meta.height <= SMALL_IMAGE_PIXELS);
      const encoded = await (lossless ? pipeline.png({ compressionLevel: 6 }) : pipeline.jpeg({ quality: 92, mozjpeg: false })).toBuffer({ resolveWithObject: true });
      bytes = encoded.data;
      kind = lossless ? 'png' : 'jpg';
      width = encoded.info.width;
      height = encoded.info.height;
    }
  } catch (error) {
    throw translateSharpError(error);
  }
  ctx.signal.throwIfAborted();

  ctx.report({ phase: 'Creating the PDF', progress: 0.7 });
  const pdf = await PDFDocument.create();
  let image;
  try {
    image = kind === 'jpg' ? await pdf.embedJpg(bytes) : await pdf.embedPng(bytes);
  } catch (error) {
    throw new MorphError('UNSUPPORTED_FORMAT', 'This image could not be placed in a PDF.', { detail: String(error) });
  }

  const pageSize = optString(ctx.options, 'pageSize');
  if (pageSize === 'image') {
    // 96 pixels per inch, the common convention for pictures without a stated resolution.
    const factor = Math.min(0.75, MAX_PAGE_POINTS / Math.max(width, height));
    const w = Math.max(1, width * factor);
    const h = Math.max(1, height * factor);
    pdf.addPage([w, h]).drawImage(image, { x: 0, y: 0, width: w, height: h });
  } else {
    const [shortSide, longSide] = PAGE_POINTS[pageSize] ?? PAGE_POINTS.a4 ?? [595.28, 841.89];
    const landscape = width > height;
    const pageWidth = landscape ? longSide : shortSide;
    const pageHeight = landscape ? shortSide : longSide;
    const margin = MARGIN_POINTS[optString(ctx.options, 'margin')] ?? 18;
    const fit = Math.min((pageWidth - 2 * margin) / width, (pageHeight - 2 * margin) / height);
    const w = width * fit;
    const h = height * fit;
    pdf.addPage([pageWidth, pageHeight]).drawImage(image, { x: (pageWidth - w) / 2, y: (pageHeight - h) / 2, width: w, height: h });
  }

  const out = path.join(ctx.workDir, 'image.pdf');
  await fs.writeFile(out, await pdf.save({ useObjectStreams: true }));
  ctx.report({ progress: 1 });
  return { files: [{ path: out, name: `${ctx.baseName}.pdf` }], packaging: 'single' };
}

export function imagePdfNotes(): string[] {
  return ['The picture is placed on a single page. Transparent areas become white.'];
}
