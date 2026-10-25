import { promises as fs } from 'node:fs';
import path from 'node:path';
import { PDFDocument } from 'pdf-lib';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { buildAnimatedGif, buildGradientImage, buildTransparentPng, writeFile } from '../helpers/fixtures';
import { createHarness, makeTempDir } from '../helpers/env';

const TARGETS = ['png', 'jpg', 'webp', 'avif', 'bmp', 'tiff', 'gif', 'ico'] as const;
const EXT: Record<string, string> = { jpg: 'jpg' };

async function webpFixtures(dir: string) {
  const lossy = await writeFile(path.join(dir, 'lossy.webp'), await sharp(await buildGradientImage(64, 40)).webp({ quality: 70 }).toBuffer());
  const lossless = await writeFile(path.join(dir, 'lossless.webp'), await sharp(await buildGradientImage(64, 40)).webp({ lossless: true }).toBuffer());
  const alpha = await writeFile(path.join(dir, 'alpha.webp'), await sharp(await buildTransparentPng()).webp({ quality: 80 }).toBuffer());
  const anim = await writeFile(path.join(dir, 'anim.webp'), await sharp(await buildAnimatedGif(), { animated: true }).webp().toBuffer());
  return { lossy, lossless, alpha, anim };
}

describe('WebP as a source', () => {
  it.each(TARGETS)('converts lossy, lossless, transparent and animated WebP to %s', async (target) => {
    const dir = await makeTempDir('webp');
    const files = await webpFixtures(dir);
    const h = await createHarness();
    for (const [name, file] of Object.entries(files)) {
      const job = await h.convert(file, target);
      expect(job.status, `${name} -> ${target}: ${job.error?.message ?? ''}`).toBe('succeeded');
      const out = job.outputs[0]?.path ?? '';
      expect(out.endsWith(`.${EXT[target] ?? target}`)).toBe(true);
      if (target !== 'bmp' && target !== 'ico') {
        const m = await sharp(out).metadata();
        expect(m.width).toBeGreaterThan(0);
      }
    }
  });

  it('offers every image format for a dropped WebP file', async () => {
    const dir = await makeTempDir('webp');
    const { lossy } = await webpFixtures(dir);
    const h = await createHarness();
    const inspected = await h.inspect(lossy);
    const available = inspected.targets.filter((t) => t.available).map((t) => t.format).sort();
    expect(available).toEqual([...TARGETS, 'pdf'].sort());
  });
});

describe('animated images and pictures in a PDF', () => {
  it('exports every frame of an animated WebP as numbered PNG files in a ZIP', async () => {
    const dir = await makeTempDir('frames');
    const { anim } = await webpFixtures(dir);
    const frames = (await sharp(anim, { animated: true }).metadata()).pages ?? 1;
    expect(frames).toBeGreaterThan(1);
    const h = await createHarness();
    const inspected = await h.inspect(anim);
    const png = inspected.targets.find((t) => t.format === 'png');
    expect(png?.options.some((o) => o.key === 'frames')).toBe(true);

    const job = await h.convert(anim, 'png', { frames: 'all' });
    expect(job.status, job.error?.message).toBe('succeeded');
    expect(job.outputs[0]?.name).toBe('anim.zip');
    expect(job.warnings.join(' ')).not.toMatch(/only the first frame/);

    const single = await h.convert(anim, 'png');
    expect(single.outputs[0]?.name.endsWith('.png')).toBe(true);
    expect(single.warnings.join(' ')).toMatch(/first frame/);
  });

  it('offers the frames option only for formats that can hold several frames', async () => {
    const dir = await makeTempDir('frames');
    const still = await writeFile(path.join(dir, 'still.png'), await buildGradientImage(20, 20));
    const h = await createHarness();
    const png = (await h.inspect(still)).targets.find((t) => t.format === 'jpg');
    expect(png?.options.some((o) => o.key === 'frames')).toBe(false);
  });

  it.each(['webp', 'png', 'jpg', 'gif', 'bmp', 'tiff'] as const)('puts a %s picture on a PDF page', async (format) => {
    const dir = await makeTempDir('imgpdf');
    const data = await sharp(await buildGradientImage(120, 80)).toFormat(format === 'jpg' ? 'jpeg' : format === 'bmp' ? 'png' : format).toBuffer();
    const source = await writeFile(path.join(dir, `pic.${format}`), data);
    if (format === 'bmp') await writeFile(source, (await import('../../src/core/engines/bmp')).encodeBmp24(await sharp(data).removeAlpha().raw().toBuffer(), 120, 80));
    const h = await createHarness();
    const job = await h.convert(source, 'pdf');
    expect(job.status, job.error?.message).toBe('succeeded');
    const pdf = await PDFDocument.load(await fs.readFile(job.outputs[0]?.path ?? ''));
    expect(pdf.getPageCount()).toBe(1);
    const { width, height } = pdf.getPage(0).getSize();
    expect(width).toBeCloseTo(841.89, 0); // a wide picture gets a landscape A4 page
    expect(height).toBeCloseTo(595.28, 0);
  });

  it('keeps a JPEG exactly as it is and supports a page the size of the picture', async () => {
    const dir = await makeTempDir('imgpdf');
    const jpeg = await writeFile(path.join(dir, 'photo.jpg'), await buildGradientImage(200, 100, 'png').then((b) => sharp(b).jpeg({ quality: 80 }).toBuffer()));
    const h = await createHarness();
    const job = await h.convert(jpeg, 'pdf', { pageSize: 'image' });
    expect(job.status, job.error?.message).toBe('succeeded');
    const bytes = await fs.readFile(job.outputs[0]?.path ?? '');
    expect(bytes.includes(await fs.readFile(jpeg))).toBe(true); // the original JPEG stream is embedded untouched
    const { width, height } = (await PDFDocument.load(bytes)).getPage(0).getSize();
    expect(width).toBeCloseTo(150, 0);
    expect(height).toBeCloseTo(75, 0);
  });
});
