import { promises as fs } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { buildPdf, writeFile } from '../helpers/fixtures';
import { createHarness, hasTool, makeTempDir } from '../helpers/env';
import { readZip } from '../helpers/zipread';

const popplerAvailable = (await hasTool('pdftoppm')) && (await hasTool('pdfinfo'));

describe.skipIf(!popplerAvailable)('PDF to images (Poppler)', () => {
  it('renders a multi-page PDF to numbered JPGs inside a ZIP, in page order', async () => {
    const dir = await makeTempDir('pdf');
    const source = await writeFile(path.join(dir, 'report.pdf'), buildPdf(12));
    const h = await createHarness();

    const inspected = await h.inspect(source);
    expect(inspected.details.pages).toBe(12);

    const job = await h.convert(source, 'jpg');
    expect(job.status, JSON.stringify(job.error)).toBe('succeeded');
    expect(job.outputs[0]?.path).toBe(path.join(dir, 'report.zip'));

    const zip = await readZip(job.outputs[0]?.path ?? '');
    expect(zip.names).toHaveLength(12);
    expect(zip.names[0]).toBe('report_page_001.jpg');
    expect(zip.names[11]).toBe('report_page_012.jpg');
    expect(zip.names).toEqual([...zip.names].sort()); // ordering is preserved
    expect(zip.magic.every((m) => m.startsWith('ffd8ff'))).toBe(true); // every entry is a real JPEG
    expect(zip.sizes.every((s) => s > 0)).toBe(true);
  });

  it('honours a page range and PNG output', async () => {
    const dir = await makeTempDir('pdf');
    const source = await writeFile(path.join(dir, 'book.pdf'), buildPdf(10));
    const h = await createHarness();
    const job = await h.convert(source, 'png', { pageRange: '2-3, 9-' });
    expect(job.status).toBe('succeeded');
    const zip = await readZip(job.outputs[0]?.path ?? '');
    expect(zip.names).toEqual(['book_page_002.png', 'book_page_003.png', 'book_page_009.png', 'book_page_010.png']);
    expect(zip.magic.every((m) => m === '89504e47')).toBe(true);
  });

  it('writes a single image (no ZIP) for a one-page PDF, or a ZIP when forced', async () => {
    const dir = await makeTempDir('pdf');
    const source = await writeFile(path.join(dir, 'one.pdf'), buildPdf(1));
    const h = await createHarness();

    const single = await h.convert(source, 'png');
    expect(single.outputs[0]?.name).toBe('one.png');
    expect((await sharp(single.outputs[0]?.path ?? '').metadata()).format).toBe('png');

    const picked = await writeFile(path.join(dir, 'long.pdf'), buildPdf(5));
    const onePage = await h.convert(picked, 'png', { pageRange: '4' });
    expect(onePage.outputs[0]?.name).toBe('long_page_004.png'); // keeps its page number

    const zipped = await h.convert(source, 'png', { packaging: 'zip' });
    expect(zipped.outputs[0]?.name).toBe('one.zip');
    expect((await readZip(zipped.outputs[0]?.path ?? '')).names).toEqual(['one_page_001.png']);
  });

  it('scales output size with the DPI setting', async () => {
    const dir = await makeTempDir('pdf');
    const source = await writeFile(path.join(dir, 'p.pdf'), buildPdf(1, { width: 360, height: 360 }));
    const h = await createHarness();
    const low = await h.convert(source, 'png', { dpi: '72' });
    const high = await h.convert(source, 'png', { dpi: '150' });
    expect((await sharp(low.outputs[0]?.path ?? '').metadata()).width).toBe(360);
    expect((await sharp(high.outputs[0]?.path ?? '').metadata()).width).toBe(750); // 360pt at 150 DPI
  });

  it('rejects invalid page ranges with a clear message and writes nothing', async () => {
    const dir = await makeTempDir('pdf');
    const source = await writeFile(path.join(dir, 'p.pdf'), buildPdf(3));
    const h = await createHarness();

    const outOfRange = await h.convert(source, 'png', { pageRange: '7' });
    expect(outOfRange.status).toBe('failed');
    expect(outOfRange.error?.message).toMatch(/only 3 pages/);

    const garbage = await h.convert(source, 'png', { pageRange: '3-1' });
    expect(garbage.status).toBe('failed');
    expect((await fs.readdir(dir)).sort()).toEqual(['p.pdf']);
  });

  it('rejects a damaged PDF as corrupt at inspection and leaves nothing behind', async () => {
    const dir = await makeTempDir('pdf');
    const good = buildPdf(2);
    const source = await writeFile(path.join(dir, 'broken.pdf'), good.subarray(0, Math.floor(good.length / 2)));
    const h = await createHarness();
    await expect(h.inspect(source)).rejects.toMatchObject({ code: 'CORRUPT_INPUT' });
    expect(await fs.readdir(dir)).toEqual(['broken.pdf']);
  });

  it('cancels a running render, reports cancelled, and removes temp work and partial output', async () => {
    const dir = await makeTempDir('pdf');
    const source = await writeFile(path.join(dir, 'big.pdf'), buildPdf(400));
    const h = await createHarness();
    const file = await h.inspect(source);
    const job = h.manager.enqueue(file.id, 'png', { dpi: '300' });

    // Cancel as soon as rendering has started.
    await new Promise<void>((resolve) => {
      const onUpdate = (snapshot: { id: string; phase: string | null; status: string }) => {
        if (snapshot.id === job.id && snapshot.status === 'running' && /Rendering page/.test(snapshot.phase ?? '')) {
          h.manager.off('updated', onUpdate);
          h.manager.cancel(job.id);
          resolve();
        }
      };
      h.manager.on('updated', onUpdate);
    });
    await h.manager.idle();

    const done = h.manager.get(job.id);
    expect(done?.status).toBe('cancelled');
    expect(done?.outputs).toEqual([]);
    expect(await fs.readdir(dir)).toEqual(['big.pdf']); // no zip, no partial, no placeholder
  });
});
