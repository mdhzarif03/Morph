import { promises as fs } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { writeDocx, writeFile, writeOdt, writeRichDocx, writeRichOdt, writeZipFile } from '../helpers/fixtures';
import { createHarness, makeTempDir } from '../helpers/env';
import { printerAvailable } from '../helpers/printer';
import { pdfPageTexts } from '../helpers/pdftext';
import { readZip } from '../helpers/zipread';

const canPrint = await printerAvailable();
const squash = (text: string) => text.replace(/\s+/g, '');
const legacyDoc = path.resolve('tests/fixtures/hello.doc');

describe.skipIf(!canPrint)('document conversion (built-in, no external programs)', () => {
  it('DOCX -> PDF produces a real PDF that contains the document text', async () => {
    const dir = await makeTempDir('doc');
    const source = path.join(dir, 'letter.docx');
    await writeDocx(source, ['Hello Morph', 'Second paragraph with ünïcödé']);
    const h = await createHarness();
    expect((await h.inspect(source)).format).toBe('docx');

    const job = await h.convert(source, 'pdf');
    expect(job.status, JSON.stringify(job.error)).toBe('succeeded');
    expect(job.outputs[0]?.path).toBe(path.join(dir, 'letter.pdf'));
    expect((await fs.readFile(job.outputs[0]?.path ?? '')).subarray(0, 5).toString('latin1')).toBe('%PDF-');
    const pages = await pdfPageTexts(job.outputs[0]?.path ?? '');
    expect(pages).toHaveLength(1);
    expect(pages[0]).toContain('Hello Morph');
    expect(pages[0]).toContain('ünïcödé');
    expect(await fs.readdir(dir)).toEqual(['letter.docx', 'letter.pdf']);
  });

  it('a real Word document keeps its page size and formatting through the whole conversion', async () => {
    const dir = await makeTempDir('doc');
    const source = path.join(dir, 'Lorem Ipsum.docx');
    await fs.copyFile(path.resolve('tests/fixtures/lorem-ipsum.docx'), source);
    const h = await createHarness();
    const job = await h.convert(source, 'png', { dpi: '72' });
    expect(job.status, JSON.stringify(job.error)).toBe('succeeded');
    const sharp = (await import('sharp')).default;
    const meta = await sharp(job.outputs[0]?.path ?? '').metadata();
    expect([meta.width, meta.height]).toEqual([612, 792]); // US Letter from the document, not A4
    // The centred 28 pt title sits in the middle of the page: dark pixels in the title band are centred horizontally.
    const { data, info } = await sharp(job.outputs[0]?.path ?? '').flatten({ background: '#fff' }).greyscale().raw().toBuffer({ resolveWithObject: true });
    let minX = info.width;
    let maxX = 0;
    for (let y = 60; y < 110; y += 1) for (let x = 0; x < info.width; x += 1) if ((data[y * info.width + x] ?? 255) < 128) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); }
    expect(maxX).toBeGreaterThan(minX);
    expect(Math.abs((minX + maxX) / 2 - info.width / 2)).toBeLessThan(12);
  });

  it('keeps headings, bold text and tables from DOCX', async () => {
    const dir = await makeTempDir('doc');
    const source = path.join(dir, 'report.docx');
    await writeRichDocx(source);
    const h = await createHarness();
    const job = await h.convert(source, 'pdf');
    expect(job.status, JSON.stringify(job.error)).toBe('succeeded');
    // Some fallback fonts are extracted glyph by glyph, so compare without whitespace.
    const text = squash((await pdfPageTexts(job.outputs[0]?.path ?? '')).join('\n'));
    expect(text).toContain('QuarterlyReport');
    expect(text).toContain('Revenuewasstrongthisquarter.');
    for (const cell of ['Region', 'Total', 'North', '1200']) expect(text).toContain(cell);
  });

  it('ODT -> PDF keeps structure, and TXT -> PDF keeps every line', async () => {
    const dir = await makeTempDir('doc');
    const odt = path.join(dir, 'notes.odt');
    await writeRichOdt(odt);
    const txt = await writeFile(path.join(dir, 'readme.txt'), 'Plain text line 1\nPlain text line 2 — with a dash\n');
    const h = await createHarness();

    const fromOdt = await h.convert(odt, 'pdf');
    expect(fromOdt.status, JSON.stringify(fromOdt.error)).toBe('succeeded');
    const odtText = squash((await pdfPageTexts(fromOdt.outputs[0]?.path ?? '')).join('\n'));
    for (const expected of ['MeetingNotes', 'Decision:approvedbyall.', 'Owner', 'Sam', 'Shipit']) expect(odtText).toContain(expected);

    const fromTxt = await h.convert(txt, 'pdf');
    expect(fromTxt.status, JSON.stringify(fromTxt.error)).toBe('succeeded');
    // Monospaced text is extracted glyph by glyph, so compare without whitespace.
    const txtText = squash((await pdfPageTexts(fromTxt.outputs[0]?.path ?? '')).join('\n'));
    expect(txtText).toContain('Plaintextline1');
    expect(txtText).toContain('Plaintextline2—withadash');
  });

  it('legacy DOC -> PDF recovers the text and warns that formatting is not kept', async () => {
    const dir = await makeTempDir('doc');
    const source = path.join(dir, 'old.doc');
    await fs.copyFile(legacyDoc, source);
    const h = await createHarness();
    expect((await h.inspect(source)).format).toBe('doc');
    const job = await h.convert(source, 'pdf');
    expect(job.status, JSON.stringify(job.error)).toBe('succeeded');
    const text = (await pdfPageTexts(job.outputs[0]?.path ?? '')).join('\n');
    expect(text).toContain('Legacy Morph document');
    expect(text).toContain('café');
    expect(job.warnings.join(' ')).toMatch(/Legacy .doc files can only be read as text/);
  });

  it('page size option switches between A4 and Letter', async () => {
    const dir = await makeTempDir('doc');
    const source = path.join(dir, 'size.docx');
    await writeDocx(source, ['size test']);
    const h = await createHarness();
    const a4 = await h.convert(source, 'png', { dpi: '72' });
    const letter = await h.convert(source, 'png', { dpi: '72', pageSize: 'Letter' });
    const sharp = (await import('sharp')).default;
    const m1 = await sharp(a4.outputs[0]?.path ?? '').metadata();
    const m2 = await sharp(letter.outputs[0]?.path ?? '').metadata();
    // A4 is 595.3 x 841.9 pt; renderers round it to 594-595 x 841-842.
    expect(m1.width).toBeGreaterThanOrEqual(594);
    expect(m1.width).toBeLessThanOrEqual(595);
    expect(m1.height).toBeGreaterThanOrEqual(841);
    expect(m1.height).toBeLessThanOrEqual(842);
    expect([m2.width, m2.height]).toEqual([612, 792]);
  });

  it('multi-page DOCX -> ZIP of ordered page images', async () => {
    const dir = await makeTempDir('doc');
    const source = path.join(dir, 'long.docx');
    await writeDocx(source, Array.from({ length: 140 }, (_, i) => `Line ${i + 1}: The quick brown fox jumps over the lazy dog.`));
    const h = await createHarness();
    const job = await h.convert(source, 'png', { dpi: '72' });
    expect(job.status, JSON.stringify(job.error)).toBe('succeeded');
    expect(job.outputs[0]?.path).toBe(path.join(dir, 'long.zip'));
    const zip = await readZip(job.outputs[0]?.path ?? '');
    expect(zip.names.length).toBeGreaterThan(1);
    expect(zip.names[0]).toBe('long_page_001.png');
    expect(zip.names).toEqual([...zip.names].sort());
    expect(zip.magic.every((m) => m === '89504e47')).toBe(true);
  });

  it('script and external resources in a hostile document are never executed or fetched', async () => {
    const dir = await makeTempDir('doc');
    const source = await writeFile(path.join(dir, 'evil.txt'), '<script>document.title="pwned"</script><img src="http://example.invalid/x.png"> <b>not bold</b>');
    const h = await createHarness();
    const job = await h.convert(source, 'pdf');
    expect(job.status, JSON.stringify(job.error)).toBe('succeeded');
    const text = squash((await pdfPageTexts(job.outputs[0]?.path ?? '')).join('\n'));
    expect(text).toContain('<script>document.title="pwned"</script>'.replace(/\s+/g, '')); // shown as text, not run
    expect(text).toContain('<b>notbold</b>');
  });

  it('rejects a damaged DOCX as corrupt and leaves nothing behind', async () => {
    const dir = await makeTempDir('doc');
    const source = path.join(dir, 'bad.docx');
    await writeDocx(source, ['text']);
    const buf = await fs.readFile(source);
    await fs.writeFile(source, buf.subarray(0, buf.length - 40));
    const h = await createHarness();
    await expect(h.inspect(source)).rejects.toMatchObject({ code: 'CORRUPT_INPUT' });
    expect(await fs.readdir(dir)).toEqual(['bad.docx']);
  });

  it('ODT with a missing content part fails as corrupt, not as a crash', async () => {
    const dir = await makeTempDir('doc');
    const source = path.join(dir, 'empty.odt');
    await writeOdt(source, ['x']);
    const h = await createHarness();
    const job = await h.convert(source, 'pdf');
    expect(job.status).toBe('succeeded'); // sanity: valid file works; the bad case follows
    const broken = path.join(dir, 'broken.odt');
    await writeZipFile(broken, [{ name: 'mimetype', data: 'application/vnd.oasis.opendocument.text', store: true }]);
    const bad = await h.convert(broken, 'pdf');
    expect(bad.status).toBe('failed');
    expect(bad.error?.code).toBe('CORRUPT_INPUT');
  });
});
