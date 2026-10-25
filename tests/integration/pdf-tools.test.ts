import { promises as fs } from 'node:fs';
import path from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import yauzl from 'yauzl';
import { PdfPreviewService } from '../../src/core/pdf-preview';
import { createHarness, makeTempDir } from '../helpers/env';
import { buildPdf, writeFile } from '../helpers/fixtures';
import { pdfPageTexts } from '../helpers/pdftext';

const squash = (text: string) => text.replace(/[\s·]+/g, '');

async function pdfFile(dir: string, name: string, pages: number, label: string): Promise<string> {
  return writeFile(path.join(dir, name), buildPdf(pages, { label }));
}

async function zipNames(file: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true }, (error, zip) => {
      if (error || !zip) return reject(error ?? new Error('zip not readable'));
      const names: string[] = [];
      zip.on('entry', (entry: yauzl.Entry) => {
        names.push(entry.fileName);
        zip.readEntry();
      });
      zip.on('end', () => resolve(names));
      zip.readEntry();
    });
  });
}

describe('PDF merge', () => {
  it('joins files in the given order and keeps every page', async () => {
    const dir = await makeTempDir('merge');
    const a = await pdfFile(dir, 'alpha.pdf', 2, 'Alpha');
    const b = await pdfFile(dir, 'beta.pdf', 3, 'Beta');
    const h = await createHarness();
    const fa = await h.inspect(a);
    const fb = await h.inspect(b);

    const job = await h.pdfTool({ kind: 'merge', items: [{ fileId: fb.id }, { fileId: fa.id }] });
    expect(job.status, job.error?.message).toBe('succeeded');
    expect(job.title).toBe('Merge 2 PDFs');
    const out = job.outputs[0];
    expect(out?.name).toBe('beta_merged.pdf');
    expect(out?.path).toBe(path.join(dir, 'beta_merged.pdf'));

    const texts = (await pdfPageTexts(out?.path ?? '')).map(squash);
    expect(texts).toEqual(['Beta1', 'Beta2', 'Beta3', 'Alpha1', 'Alpha2']);
    // The originals are untouched.
    expect((await PDFDocument.load(await fs.readFile(a))).getPageCount()).toBe(2);
  });

  it('leaves out pages the user unticked', async () => {
    const dir = await makeTempDir('merge');
    const a = await pdfFile(dir, 'a.pdf', 4, 'A');
    const b = await pdfFile(dir, 'b.pdf', 3, 'B');
    const h = await createHarness();
    const fa = await h.inspect(a);
    const fb = await h.inspect(b);
    const job = await h.pdfTool({ kind: 'merge', items: [{ fileId: fa.id, pages: [1, 4] }, { fileId: fb.id, pages: [2] }] });
    expect(job.status, job.error?.message).toBe('succeeded');
    expect((await pdfPageTexts(job.outputs[0]?.path ?? '')).map(squash)).toEqual(['A1', 'A4', 'B2']);
  });

  it('never overwrites an earlier merge result', async () => {
    const dir = await makeTempDir('merge');
    const a = await pdfFile(dir, 'a.pdf', 1, 'A');
    const b = await pdfFile(dir, 'b.pdf', 1, 'B');
    const h = await createHarness();
    const request = { kind: 'merge' as const, items: [{ fileId: (await h.inspect(a)).id }, { fileId: (await h.inspect(b)).id }] };
    const first = await h.pdfTool(request);
    const second = await h.pdfTool(request);
    expect(first.outputs[0]?.name).toBe('a_merged.pdf');
    expect(second.outputs[0]?.name).toBe('a_merged (1).pdf');
  });

  it('rejects a page that does not exist and an encrypted file', async () => {
    const dir = await makeTempDir('merge');
    const a = await pdfFile(dir, 'a.pdf', 2, 'A');
    const b = await pdfFile(dir, 'b.pdf', 2, 'B');
    const h = await createHarness();
    const fa = await h.inspect(a);
    const fb = await h.inspect(b);
    const bad = await h.pdfTool({ kind: 'merge', items: [{ fileId: fa.id, pages: [9] }, { fileId: fb.id }] });
    expect(bad.status).toBe('failed');
    expect(bad.error?.message).toMatch(/page 9 does not exist/);

    // A PDF whose trailer announces encryption must be refused, not "unlocked".
    const doc = await PDFDocument.load(await fs.readFile(b));
    doc.context.trailerInfo.Encrypt = doc.context.register(doc.context.obj({ Filter: 'Standard' }));
    const locked = await writeFile(path.join(dir, 'locked.pdf'), Buffer.from(await doc.save()));
    // Registered with the same path/size, but inspect would also reject it; register through the registry directly.
    const entry = h.registry.add({ path: locked, realPath: locked, size: (await fs.stat(locked)).size, mtimeMs: (await fs.stat(locked)).mtimeMs, format: 'pdf', baseName: 'locked' });
    const refused = await h.pdfTool({ kind: 'merge', items: [{ fileId: fa.id }, { fileId: entry.id }] });
    expect(refused.status).toBe('failed');
    expect(refused.error?.code).toBe('PASSWORD_PROTECTED');
  });
});

describe('PDF split', () => {
  it('extracts the chosen pages into one PDF', async () => {
    const dir = await makeTempDir('split');
    const src = await pdfFile(dir, 'book.pdf', 6, 'P');
    const h = await createHarness();
    const f = await h.inspect(src);
    const job = await h.pdfTool({ kind: 'split', item: { fileId: f.id, pages: [2, 3, 6] }, mode: 'extract' });
    expect(job.status, job.error?.message).toBe('succeeded');
    expect(job.outputs[0]?.name).toBe('book_pages_2-3_6.pdf');
    expect((await pdfPageTexts(job.outputs[0]?.path ?? '')).map(squash)).toEqual(['P2', 'P3', 'P6']);
  });

  it('saves every page as its own PDF inside a ZIP', async () => {
    const dir = await makeTempDir('split');
    const src = await pdfFile(dir, 'book.pdf', 3, 'P');
    const h = await createHarness();
    const f = await h.inspect(src);
    const job = await h.pdfTool({ kind: 'split', item: { fileId: f.id }, mode: 'each' });
    expect(job.status, job.error?.message).toBe('succeeded');
    expect(job.outputs[0]?.name).toBe('book.zip');
    expect((await zipNames(job.outputs[0]?.path ?? '')).sort()).toEqual(['book_page_001.pdf', 'book_page_002.pdf', 'book_page_003.pdf']);
  });

  it('cuts at typed ranges and into equal parts', async () => {
    const dir = await makeTempDir('split');
    const src = await pdfFile(dir, 'doc.pdf', 7, 'D');
    const h = await createHarness();
    const f = await h.inspect(src);

    const ranges = await h.pdfTool({ kind: 'split', item: { fileId: f.id }, mode: 'ranges', ranges: '1-2, 3, 5-' });
    expect(ranges.status, ranges.error?.message).toBe('succeeded');
    expect((await zipNames(ranges.outputs[0]?.path ?? '')).sort()).toEqual(['doc_part_001_pages_1-2.pdf', 'doc_part_002_pages_3.pdf', 'doc_part_003_pages_5-7.pdf']);

    const every = await h.pdfTool({ kind: 'split', item: { fileId: f.id }, mode: 'every', every: 3 });
    expect(every.status, every.error?.message).toBe('succeeded');
    expect((await zipNames(every.outputs[0]?.path ?? '')).length).toBe(3);
  });

  it('explains bad ranges', async () => {
    const dir = await makeTempDir('split');
    const f = await (await createHarness()).inspect(await pdfFile(dir, 'doc.pdf', 3, 'D'));
    const h = await createHarness();
    const again = await h.inspect(f.path);
    const job = await h.pdfTool({ kind: 'split', item: { fileId: again.id }, mode: 'ranges', ranges: '5-9' });
    expect(job.status).toBe('failed');
    expect(job.error?.message).toMatch(/only 3 pages/);
  });
});

describe('PDF page previews', () => {
  it('renders thumbnails page by page with the right proportions', async () => {
    const dir = await makeTempDir('preview');
    const src = await writeFile(path.join(dir, 'wide.pdf'), buildPdf(30, { width: 400, height: 200, label: 'W' }));
    const h = await createHarness();
    const f = await h.inspect(src);
    const service = new PdfPreviewService(h.registry);
    try {
      const first = await service.pages(f.id, 0, 12);
      expect(first.pageCount).toBe(30);
      expect(first.pages.map((p) => p.page)).toEqual(Array.from({ length: 12 }, (_, i) => i + 1));
      expect(first.pages[0]?.src.startsWith('data:image/jpeg;base64,')).toBe(true);
      expect(first.pages[0]?.widthPt).toBe(400);
      const last = await service.pages(f.id, 24, 12);
      expect(last.pages.map((p) => p.page)).toEqual([25, 26, 27, 28, 29, 30]);
    } finally {
      service.dispose();
    }
  });

  it('refuses files that are not PDFs or are unknown', async () => {
    const dir = await makeTempDir('preview');
    const png = await writeFile(path.join(dir, 'x.txt'), 'hello');
    const h = await createHarness();
    const f = await h.inspect(png);
    const service = new PdfPreviewService(h.registry);
    await expect(service.pages(f.id, 0, 4)).rejects.toThrow(/Only PDF/);
    await expect(service.pages('nope', 0, 4)).rejects.toThrow(/no longer available/);
  });
});
