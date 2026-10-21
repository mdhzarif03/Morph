import { promises as fs } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { buildAnimatedGif, buildGradientImage, buildTransparentPng, writeFile } from '../helpers/fixtures';
import { createHarness, makeTempDir } from '../helpers/env';

async function meta(file: string) {
  return sharp(file, { animated: true }).metadata();
}

describe('image conversion', () => {
  it('converts PNG to WebP next to the original, leaving the original untouched', async () => {
    const dir = await makeTempDir('img');
    const source = await writeFile(path.join(dir, 'logo.png'), await buildTransparentPng());
    const before = await fs.readFile(source);

    const h = await createHarness();
    const job = await h.convert(source, 'webp');

    expect(job.status).toBe('succeeded');
    expect(job.outputs[0]?.path).toBe(path.join(dir, 'logo.webp'));
    const m = await meta(path.join(dir, 'logo.webp'));
    expect(m.format).toBe('webp');
    expect(m.hasAlpha).toBe(true); // transparency preserved
    expect(await fs.readFile(source)).toEqual(before); // original byte-identical
  });

  it('never overwrites an existing file and picks "name (1)" deterministically', async () => {
    const dir = await makeTempDir('img');
    const source = await writeFile(path.join(dir, 'logo.png'), await buildGradientImage(20, 20));
    const existing = await writeFile(path.join(dir, 'logo.webp'), 'precious user data');

    const h = await createHarness();
    const first = await h.convert(source, 'webp');
    const second = await h.convert(source, 'webp');

    expect(first.outputs[0]?.name).toBe('logo (1).webp');
    expect(second.outputs[0]?.name).toBe('logo (2).webp');
    expect(await fs.readFile(existing, 'utf8')).toBe('precious user data');
  });

  it('flattens transparency onto the chosen background for JPG', async () => {
    const dir = await makeTempDir('img');
    const source = await writeFile(path.join(dir, 'icon.png'), await buildTransparentPng());
    const h = await createHarness();
    const job = await h.convert(source, 'jpg', { background: '#00ff00' });

    expect(job.status).toBe('succeeded');
    expect(job.warnings.join(' ')).toMatch(/filled with #00ff00/);
    const { data } = await sharp(path.join(dir, 'icon.jpg')).raw().toBuffer({ resolveWithObject: true });
    // corner pixel was transparent -> now green
    expect(data[1]).toBeGreaterThan(200);
    expect(data[0]).toBeLessThan(60);
  });

  it.each(['png', 'jpg', 'webp', 'avif', 'bmp', 'tiff', 'gif', 'ico'] as const)('produces a valid %s file from a PNG', async (target) => {
    const dir = await makeTempDir('img');
    const source = await writeFile(path.join(dir, 'photo.png'), await buildGradientImage(48, 32));
    const h = await createHarness();
    const job = await h.convert(source, target, target === 'png' ? { maxWidth: 24 } : {});
    expect(job.status, JSON.stringify(job.error)).toBe('succeeded');
    const out = job.outputs[0]?.path ?? '';
    expect((await fs.stat(out)).size).toBeGreaterThan(0);
    if (target === 'bmp') {
      const buf = await fs.readFile(out);
      expect(buf.toString('latin1', 0, 2)).toBe('BM');
      expect(buf.readInt32LE(18)).toBe(48);
    } else if (target === 'ico') {
      const buf = await fs.readFile(out);
      expect(buf.readUInt16LE(2)).toBe(1);
      expect(buf.readUInt16LE(4)).toBeGreaterThanOrEqual(1);
    } else {
      const m = await meta(out);
      expect(m.width).toBe(target === 'png' ? 24 : 48);
    }
  });

  it('round-trips BMP and ICO through the custom decoders', async () => {
    const dir = await makeTempDir('img');
    const png = await writeFile(path.join(dir, 'src.png'), await buildGradientImage(40, 40));
    const h = await createHarness();
    const bmp = await h.convert(png, 'bmp');
    const fromBmp = await h.convert(bmp.outputs[0]?.path ?? '', 'png');
    expect(fromBmp.status).toBe('succeeded');
    expect((await meta(fromBmp.outputs[0]?.path ?? '')).width).toBe(40);

    const ico = await h.convert(png, 'ico', { icoSizes: 'small' });
    const fromIco = await h.convert(ico.outputs[0]?.path ?? '', 'png');
    expect(fromIco.status).toBe('succeeded');
    expect((await meta(fromIco.outputs[0]?.path ?? '')).width).toBe(48); // largest embedded size
  });

  it('keeps animation for GIF -> WebP and warns when flattening to a still format', async () => {
    const dir = await makeTempDir('img');
    const gif = await writeFile(path.join(dir, 'anim.gif'), await buildAnimatedGif());
    const h = await createHarness();

    const animated = await h.convert(gif, 'webp');
    expect(animated.status).toBe('succeeded');
    expect((await meta(animated.outputs[0]?.path ?? '')).pages).toBe(3);

    const still = await h.convert(gif, 'png');
    expect(still.status).toBe('succeeded');
    expect(still.warnings.join(' ')).toMatch(/only the first frame/);
    expect((await meta(still.outputs[0]?.path ?? '')).pages ?? 1).toBe(1);
  });

  it('applies "suffix" naming and an output directory override', async () => {
    const dir = await makeTempDir('img');
    const outDir = await makeTempDir('out');
    const source = await writeFile(path.join(dir, 'a.png'), await buildGradientImage(10, 10));
    const h = await createHarness({ output: { naming: 'suffix', suffix: '_small', directory: outDir } });
    const job = await h.convert(source, 'jpg');
    expect(job.outputs[0]?.path).toBe(path.join(outDir, 'a_small.jpg'));
    expect(await fs.readdir(dir)).toEqual(['a.png']);
  });
});
