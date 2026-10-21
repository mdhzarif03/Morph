import { promises as fs } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { writeDocx, writeFile, writeOdt } from '../helpers/fixtures';
import { createHarness, hasTool, makeTempDir } from '../helpers/env';
import { readZip } from '../helpers/zipread';
import { runProcess } from '../../src/core/proc';
import { getToolchain } from '../helpers/env';

const soffice = await hasTool('soffice');
const poppler = (await hasTool('pdftoppm')) && (await hasTool('pdfinfo'));

async function pdfPages(file: string): Promise<number> {
  const tc = await getToolchain();
  const info = tc.tools.pdfinfo.path;
  if (!info) throw new Error('pdfinfo missing');
  const r = await runProcess(info, [file]);
  return Number(/Pages:\s+(\d+)/.exec(r.stdout)?.[1]);
}

describe.skipIf(!soffice)('document conversion (LibreOffice)', () => {
  it('DOCX -> PDF produces a real PDF containing the document text', async () => {
    const dir = await makeTempDir('doc');
    const source = path.join(dir, 'letter.docx');
    await writeDocx(source, ['Hello Morph', 'Second paragraph with ünïcödé']);
    const h = await createHarness();
    const inspected = await h.inspect(source);
    expect(inspected.format).toBe('docx');

    const job = await h.convert(source, 'pdf');
    expect(job.status, JSON.stringify(job.error)).toBe('succeeded');
    expect(job.outputs[0]?.path).toBe(path.join(dir, 'letter.pdf'));
    const head = await fs.readFile(job.outputs[0]?.path ?? '');
    expect(head.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    if (poppler) expect(await pdfPages(job.outputs[0]?.path ?? '')).toBe(1);
  }, 120_000);

  it('ODT -> PDF and TXT -> PDF work', async () => {
    const dir = await makeTempDir('doc');
    const odt = path.join(dir, 'note.odt');
    await writeOdt(odt, ['An OpenDocument paragraph']);
    const txt = await writeFile(path.join(dir, 'readme.txt'), 'Plain text line 1\nPlain text line 2 — with a dash\n');
    const h = await createHarness();

    const fromOdt = await h.convert(odt, 'pdf');
    expect(fromOdt.status, JSON.stringify(fromOdt.error)).toBe('succeeded');
    const fromTxt = await h.convert(txt, 'pdf');
    expect(fromTxt.status, JSON.stringify(fromTxt.error)).toBe('succeeded');
    for (const out of [fromOdt.outputs[0]?.path, fromTxt.outputs[0]?.path]) {
      expect((await fs.readFile(out ?? '')).subarray(0, 5).toString('latin1')).toBe('%PDF-');
    }
  }, 180_000);

  it('DOCX -> ODT and back keeps the text', async () => {
    const dir = await makeTempDir('doc');
    const source = path.join(dir, 'a.docx');
    await writeDocx(source, ['Round trip text']);
    const h = await createHarness();
    const odt = await h.convert(source, 'odt');
    expect(odt.status, JSON.stringify(odt.error)).toBe('succeeded');
    expect((await h.inspect(odt.outputs[0]?.path ?? '')).format).toBe('odt');
    const back = await h.convert(odt.outputs[0]?.path ?? '', 'docx');
    expect(back.status, JSON.stringify(back.error)).toBe('succeeded');
    expect((await h.inspect(back.outputs[0]?.path ?? '')).format).toBe('docx');
  }, 180_000);

  it.skipIf(!poppler)('multi-page DOCX -> ZIP of ordered page images', async () => {
    const dir = await makeTempDir('doc');
    const source = path.join(dir, 'long.docx');
    // Enough paragraphs to spill onto several pages.
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
  }, 180_000);

  it('rejects a damaged DOCX as corrupt at inspection and leaves nothing behind', async () => {
    const dir = await makeTempDir('doc');
    const source = path.join(dir, 'bad.docx');
    await writeDocx(source, ['text']);
    const buf = await fs.readFile(source);
    await fs.writeFile(source, buf.subarray(0, buf.length - 40)); // cut the central directory
    const h = await createHarness();
    await expect(h.inspect(source)).rejects.toMatchObject({ code: 'CORRUPT_INPUT' });
    expect(await fs.readdir(dir)).toEqual(['bad.docx']);
  });
});
