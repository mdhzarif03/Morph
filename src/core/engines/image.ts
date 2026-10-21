import { promises as fs } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import type { Metadata, Sharp } from 'sharp';
import { MorphError, isAbortError } from '../../shared/errors';
import { FORMATS, outputExtension, type FormatId } from '../../shared/formats';
import { optBoolean, optNumber, optNumberOrNull, optString, type OptionSpec } from '../../shared/options';
import type { FileDetails } from '../../shared/types';
import { decodeBmp, encodeBmp24, type RawImage } from './bmp';
import { decodeIcoLargest, encodeIco, icoLargestSize } from './ico';
import { MAX_ANIMATED_PIXELS, MAX_INPUT_PIXELS, type EngineContext, type EngineResult } from './types';

export const IMAGE_FORMATS: readonly FormatId[] = ['png', 'jpg', 'webp', 'avif', 'bmp', 'tiff', 'gif', 'ico'];

export interface QualityDefaults {
  jpg: number;
  webp: number;
  avif: number;
}

const MAX_RAW_FILE_BYTES = 512 * 1024 * 1024;

/** Largest pixel dimension each encoder accepts. */
const MAX_DIMENSION: Partial<Record<FormatId, number>> = {
  webp: 16383,
  avif: 16384,
  jpg: 65500,
  gif: 65535,
};

// ---------------------------------------------------------------------------------------------
// Option specs

const resizeSpecs: OptionSpec[] = [
  { key: 'maxWidth', type: 'number', label: 'Max width', min: 1, max: 16384, default: null, unit: 'px', placeholder: 'Original' },
  { key: 'maxHeight', type: 'number', label: 'Max height', min: 1, max: 16384, default: null, unit: 'px', placeholder: 'Original' },
];

const metadataSpec: OptionSpec = {
  key: 'keepMetadata',
  type: 'boolean',
  label: 'Keep metadata (EXIF, camera, location)',
  default: false,
  help: 'Removed by default for privacy. The image orientation is always applied.',
};

const backgroundSpec: OptionSpec = {
  key: 'background',
  type: 'color',
  label: 'Background colour',
  default: '#ffffff',
  help: 'Transparent areas are filled with this colour because this format cannot store transparency.',
};

export function imageOptionSpecs(target: FormatId, defaults: QualityDefaults): OptionSpec[] {
  switch (target) {
    case 'png':
      return [...resizeSpecs, metadataSpec];
    case 'jpg':
      return [{ key: 'quality', type: 'range', label: 'Quality', min: 1, max: 100, step: 1, default: defaults.jpg }, backgroundSpec, ...resizeSpecs, metadataSpec];
    case 'webp':
      return [
        { key: 'lossless', type: 'boolean', label: 'Lossless', default: false, help: 'Larger files, no quality loss.' },
        { key: 'quality', type: 'range', label: 'Quality', min: 1, max: 100, step: 1, default: defaults.webp, visibleWhen: { key: 'lossless', equals: [false] } },
        ...resizeSpecs,
        metadataSpec,
      ];
    case 'avif':
      return [{ key: 'quality', type: 'range', label: 'Quality', min: 1, max: 100, step: 1, default: defaults.avif }, ...resizeSpecs, metadataSpec];
    case 'tiff':
      return [
        {
          key: 'compression',
          type: 'select',
          label: 'Compression',
          default: 'lzw',
          choices: [
            { value: 'lzw', label: 'LZW (lossless)' },
            { value: 'deflate', label: 'Deflate (lossless)' },
            { value: 'jpeg', label: 'JPEG (smaller, lossy)' },
            { value: 'none', label: 'None' },
          ],
        },
        { key: 'quality', type: 'range', label: 'JPEG quality', min: 1, max: 100, step: 1, default: defaults.jpg, visibleWhen: { key: 'compression', equals: ['jpeg'] } },
        ...resizeSpecs,
        metadataSpec,
      ];
    case 'gif':
      return [{ key: 'colors', type: 'range', label: 'Colours', min: 2, max: 256, step: 1, default: 256, help: 'Fewer colours make smaller files.' }, ...resizeSpecs];
    case 'bmp':
      return [backgroundSpec, ...resizeSpecs];
    case 'ico':
      return [
        {
          key: 'icoSizes',
          type: 'select',
          label: 'Icon sizes',
          default: 'standard',
          choices: [
            { value: 'standard', label: 'Standard set', description: '16, 24, 32, 48, 64, 128, 256 px' },
            { value: 'small', label: 'Small set', description: '16, 32, 48 px' },
            { value: 'large', label: 'Single 256 px', description: 'One 256 × 256 image' },
          ],
          help: 'Non-square images are centred on a transparent square.',
        },
      ];
    default:
      return [];
  }
}

export function imageNotes(source: FormatId, target: FormatId): string[] {
  const notes: string[] = [];
  const t = FORMATS[target];
  const s = FORMATS[source];
  if (!t.supportsTransparency && s.supportsTransparency) {
    notes.push(`${t.label} cannot store transparency. Transparent areas are filled with the background colour you choose.`);
  }
  if (s.supportsAnimation && !t.supportsAnimation) notes.push(`${t.label} cannot hold animation. Animated images are converted to a single still frame.`);
  notes.push('Size limits only scale images down and keep their proportions.');
  if (source === target) notes.push('Same format: the image is re-encoded, which is useful for resizing or compressing.');
  if (target === 'gif') notes.push('GIF supports only fully transparent or fully opaque pixels, so soft edges become hard.');
  if (target === 'avif') notes.push('AVIF encoding is slow for large images.');
  return notes;
}

// ---------------------------------------------------------------------------------------------
// Loading

interface SourceMeta {
  width: number;
  height: number;
  pages: number;
  hasAlpha: boolean;
  orientation: number;
  space: string | undefined;
}

interface LoadedSource {
  meta: SourceMeta;
  create(animated: boolean): Sharp;
}

function translateSharpError(error: unknown): MorphError {
  if (error instanceof MorphError) return error;
  if (isAbortError(error)) return error as MorphError;
  const message = error instanceof Error ? error.message : String(error);
  if (/pixel limit/i.test(message)) {
    return new MorphError('INPUT_TOO_LARGE', 'The image has too many pixels to convert safely.', { detail: message });
  }
  if (/Input buffer contains unsupported image format|unsupported image format/i.test(message)) {
    return new MorphError('UNSUPPORTED_FORMAT', 'This image format variant is not supported.', { detail: message });
  }
  if (/dimensions|too large|Maximum/i.test(message) && /webp|heif|avif|gif|jpeg/i.test(message)) {
    return new MorphError('INPUT_TOO_LARGE', 'The resulting image is too large for the chosen format.', { detail: message });
  }
  if (/memory|alloc/i.test(message)) {
    return new MorphError('INPUT_TOO_LARGE', 'There is not enough memory to convert this image.', { detail: message });
  }
  return new MorphError('CORRUPT_INPUT', 'The image could not be read. The file may be damaged or truncated.', { detail: message });
}

const sharpInputOptions = { limitInputPixels: MAX_INPUT_PIXELS, failOn: 'error' } as const;

async function readRawFile(filePath: string): Promise<Buffer> {
  const stat = await fs.stat(filePath);
  if (stat.size > MAX_RAW_FILE_BYTES) throw new MorphError('INPUT_TOO_LARGE', 'This image file is too large to convert.');
  return fs.readFile(filePath);
}

function rawSource(image: RawImage): LoadedSource {
  return {
    meta: { width: image.width, height: image.height, pages: 1, hasAlpha: true, orientation: 1, space: 'srgb' },
    create: () => sharp(image.rgba, { raw: { width: image.width, height: image.height, channels: 4 }, limitInputPixels: false }),
  };
}

async function loadSource(filePath: string, format: FormatId): Promise<LoadedSource> {
  try {
    if (format === 'bmp') return rawSource(decodeBmp(await readRawFile(filePath)));
    if (format === 'ico') {
      const decoded = decodeIcoLargest(await readRawFile(filePath));
      if (decoded.kind === 'raw') return rawSource(decoded.image);
      return loadBuffer(decoded.data);
    }
    const metadata = await sharp(filePath, sharpInputOptions).metadata();
    const meta = readMeta(metadata);
    return { meta, create: (animated) => sharp(filePath, { ...sharpInputOptions, animated, sequentialRead: true }) };
  } catch (error) {
    throw translateSharpError(error);
  }
}

async function loadBuffer(data: Buffer): Promise<LoadedSource> {
  const metadata = await sharp(data, sharpInputOptions).metadata();
  return { meta: readMeta(metadata), create: (animated) => sharp(data, { ...sharpInputOptions, animated }) };
}

function readMeta(metadata: Metadata): SourceMeta {
  const width = metadata.width ?? 0;
  const height = metadata.height ?? 0;
  if (width <= 0 || height <= 0) throw new MorphError('CORRUPT_INPUT', 'The image has no readable dimensions.');
  if (width * height > MAX_INPUT_PIXELS) {
    throw new MorphError('INPUT_TOO_LARGE', 'The image has too many pixels to convert safely.', {
      detail: `${width}×${height} exceeds the ${MAX_INPUT_PIXELS.toLocaleString('en-US')} pixel limit`,
    });
  }
  return {
    width,
    height,
    pages: metadata.pages ?? 1,
    hasAlpha: metadata.hasAlpha ?? false,
    orientation: metadata.orientation ?? 1,
    space: metadata.space,
  };
}

// ---------------------------------------------------------------------------------------------
// Inspection (header only, plus an optional small preview)

const PREVIEW_MAX_PIXELS = 25_000_000;

export async function inspectImage(filePath: string, format: FormatId, withPreview: boolean): Promise<{ details: FileDetails; preview?: string }> {
  try {
    let source: LoadedSource;
    if (format === 'ico') {
      const buf = await readRawFile(filePath);
      const size = icoLargestSize(buf);
      const details: FileDetails = { width: size.width, height: size.height, pages: 1, hasAlpha: true, animated: false };
      if (!withPreview) return { details };
      source = await loadSource(filePath, format);
      return { details, preview: await thumbnail(source.create(false)) };
    }
    if (format === 'bmp') {
      const buf = await readRawFile(filePath);
      if (buf.length < 26) throw new MorphError('CORRUPT_INPUT', 'The BMP image is damaged.');
      const width = Math.abs(buf.readInt32LE(18));
      const height = Math.abs(buf.readInt32LE(22));
      if (buf.readUInt32LE(14) === 12) {
        // OS/2 header: 16-bit dimensions
        const w = buf.readUInt16LE(18);
        const h = buf.readUInt16LE(20);
        return finishBmp(buf, w, h, withPreview);
      }
      return finishBmp(buf, width, height, withPreview);
    }
    source = await loadSource(filePath, format);
    const { meta } = source;
    const details: FileDetails = {
      width: meta.width,
      height: meta.height,
      pages: meta.pages,
      hasAlpha: meta.hasAlpha,
      animated: meta.pages > 1 && (format === 'gif' || format === 'webp'),
    };
    if (!withPreview || meta.width * meta.height > PREVIEW_MAX_PIXELS) return { details };
    return { details, preview: await thumbnail(source.create(false)) };
  } catch (error) {
    throw translateSharpError(error);
  }
}

async function finishBmp(buf: Buffer, width: number, height: number, withPreview: boolean): Promise<{ details: FileDetails; preview?: string }> {
  if (width <= 0 || height <= 0) throw new MorphError('CORRUPT_INPUT', 'The BMP image is damaged.');
  const details: FileDetails = { width, height, pages: 1, hasAlpha: false, animated: false };
  if (!withPreview || width * height > PREVIEW_MAX_PIXELS || width * height > MAX_INPUT_PIXELS) return { details };
  const decoded = rawSource(decodeBmp(buf));
  return { details, preview: await thumbnail(decoded.create(false)) };
}

async function thumbnail(pipeline: Sharp): Promise<string> {
  const buf = await pipeline.rotate().resize({ width: 160, height: 160, fit: 'inside', withoutEnlargement: true }).webp({ quality: 70 }).toBuffer();
  return `data:image/webp;base64,${buf.toString('base64')}`;
}

// ---------------------------------------------------------------------------------------------
// Conversion

function icoSizesFor(choice: string): number[] {
  switch (choice) {
    case 'small':
      return [16, 32, 48];
    case 'large':
      return [256];
    default:
      return [16, 24, 32, 48, 64, 128, 256];
  }
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  return { r: parseInt(hex.slice(1, 3), 16), g: parseInt(hex.slice(3, 5), 16), b: parseInt(hex.slice(5, 7), 16) };
}

export async function convertImage(ctx: EngineContext): Promise<EngineResult> {
  const { sourceFormat, targetFormat: target, options } = ctx;
  const targetInfo = FORMATS[target];
  const outputName = `${ctx.baseName}.${outputExtension(target)}`;
  const outputPath = path.join(ctx.workDir, `output.${outputExtension(target)}`);

  ctx.report({ phase: 'Reading image', progress: null });
  const source = await loadSource(ctx.sourcePath, sourceFormat);
  const { meta } = source;
  ctx.signal.throwIfAborted();

  // Animation: keep it only when both ends support it and the frames fit in the memory budget.
  let animated = false;
  if (meta.pages > 1) {
    if (FORMATS[sourceFormat].supportsAnimation && targetInfo.supportsAnimation) {
      if (meta.width * meta.height * meta.pages <= MAX_ANIMATED_PIXELS) animated = true;
      else ctx.warn('The animation is too large to keep in memory, so only the first frame was converted.');
    } else if (sourceFormat === 'tiff') {
      ctx.warn(`This TIFF has ${meta.pages} pages. Only the first page was converted.`);
    } else {
      ctx.warn(`The animation has ${meta.pages} frames. ${targetInfo.label} cannot hold animation, so only the first frame was converted.`);
    }
  }

  const maxWidth = optNumberOrNull(options, 'maxWidth');
  const maxHeight = optNumberOrNull(options, 'maxHeight');
  const scale = Math.min(maxWidth ? maxWidth / meta.width : 1, maxHeight ? maxHeight / meta.height : 1, 1);
  const finalWidth = Math.max(1, Math.round(meta.width * scale));
  const finalHeight = Math.max(1, Math.round(meta.height * scale));
  const limit = MAX_DIMENSION[target];
  if (limit !== undefined && (finalWidth > limit || finalHeight > limit)) {
    throw new MorphError('INPUT_TOO_LARGE', `${targetInfo.label} supports images up to ${limit.toLocaleString('en-US')} pixels on each side. Use the size limits to scale this image down.`, {
      detail: `${finalWidth}×${finalHeight}`,
    });
  }

  ctx.report({ phase: `Converting to ${targetInfo.label}`, progress: null });
  try {
    if (target === 'ico') {
      await writeIco(source, options, outputPath, ctx);
    } else {
      let pipeline = source.create(animated);
      if (!animated && meta.orientation > 1) pipeline = pipeline.rotate();
      if (meta.space === 'cmyk') pipeline = pipeline.toColourspace('srgb');
      if (scale < 1) pipeline = pipeline.resize({ width: finalWidth, height: finalHeight, fit: 'inside', withoutEnlargement: true });

      const needsFlatten = meta.hasAlpha && !targetInfo.supportsTransparency;
      if (needsFlatten) {
        const background = optString(options, 'background');
        pipeline = pipeline.flatten({ background: hexToRgb(background) });
        ctx.warn(`Transparent areas were filled with ${background}.`);
      }
      if (optionalBoolean(options, 'keepMetadata')) pipeline = pipeline.keepMetadata();

      if (target === 'bmp') {
        const { data, info } = await pipeline.removeAlpha().toColourspace('srgb').raw().toBuffer({ resolveWithObject: true });
        if (info.channels !== 3) throw new MorphError('INTERNAL', 'Unexpected pixel layout while writing BMP.');
        await fs.writeFile(outputPath, encodeBmp24(data, info.width, info.height));
      } else {
        await encode(pipeline, target, options).toFile(outputPath);
      }
    }
  } catch (error) {
    throw translateSharpError(error);
  }

  ctx.signal.throwIfAborted();
  ctx.report({ progress: 1 });
  return { files: [{ path: outputPath, name: outputName }], packaging: 'single' };
}

function optionalBoolean(options: EngineContext['options'], key: string): boolean {
  return key in options ? optBoolean(options, key) : false;
}

function encode(pipeline: Sharp, target: FormatId, options: EngineContext['options']): Sharp {
  switch (target) {
    case 'png':
      return pipeline.png({ compressionLevel: 6 });
    case 'jpg': {
      const quality = optNumber(options, 'quality');
      return pipeline.jpeg({ quality, chromaSubsampling: quality >= 90 ? '4:4:4' : '4:2:0', mozjpeg: false });
    }
    case 'webp': {
      const lossless = optBoolean(options, 'lossless');
      return pipeline.webp(lossless ? { lossless: true, effort: 4 } : { quality: optNumber(options, 'quality'), effort: 4 });
    }
    case 'avif':
      return pipeline.avif({ quality: optNumber(options, 'quality'), effort: 4 });
    case 'tiff': {
      const compression = optString(options, 'compression') as 'lzw' | 'deflate' | 'jpeg' | 'none';
      return pipeline.tiff(compression === 'jpeg' ? { compression, quality: optNumber(options, 'quality') } : { compression });
    }
    case 'gif':
      return pipeline.gif({ colours: optNumber(options, 'colors'), effort: 7 });
    default:
      throw new MorphError('INTERNAL', `No image encoder for ${target}.`);
  }
}

async function writeIco(source: LoadedSource, options: EngineContext['options'], outputPath: string, ctx: EngineContext): Promise<void> {
  const sizes = icoSizesFor(optString(options, 'icoSizes'));
  const images: Array<{ size: number; png: Buffer }> = [];
  for (const size of sizes) {
    ctx.signal.throwIfAborted();
    let pipeline = source.create(false);
    if (source.meta.orientation > 1) pipeline = pipeline.rotate();
    const png = await pipeline
      .resize({ width: size, height: size, fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .ensureAlpha()
      .png()
      .toBuffer();
    images.push({ size, png });
  }
  if (Math.max(source.meta.width, source.meta.height) < Math.max(...sizes) / 2) {
    ctx.warn('The source image is much smaller than the largest icon size, so larger icons will look soft.');
  }
  await fs.writeFile(outputPath, encodeIco(images));
}
