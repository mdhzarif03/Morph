import { createWriteStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import yazl from 'yazl';
import { describe, expect, it } from 'vitest';
import { docxToHtml } from '../../src/core/engines/docs/docx';
import { buildTransparentPng, writeCustomDocx } from '../helpers/fixtures';
import { makeTempDir } from '../helpers/env';

const lorem = path.resolve('tests/fixtures/lorem-ipsum.docx');

async function html(parts: Parameters<typeof writeCustomDocx>[1]) {
  const dir = await makeTempDir('docx');
  const file = path.join(dir, 't.docx');
  await writeCustomDocx(file, parts);
  return docxToHtml(file);
}
const run = (text: string, rPr = '') => `<w:r>${rPr ? `<w:rPr>${rPr}</w:rPr>` : ''}<w:t xml:space="preserve">${text}</w:t></w:r>`;
const para = (inner: string, pPr = '') => `<w:p>${pPr ? `<w:pPr>${pPr}</w:pPr>` : ''}${inner}</w:p>`;

describe('DOCX fidelity: a real Word document', () => {
  it('keeps the page setup, fonts, sizes, alignment, colour and italics of a Word file', async () => {
    const result = await docxToHtml(lorem);
    expect(result.page).toEqual({ widthPt: 612, heightPt: 792, top: 72, right: 72, bottom: 72, left: 72 });
    expect(result.body).toContain("'Times New Roman'");
    const title = result.body.split('\n').find((l) => l.includes('Lorem Ipsum')) ?? '';
    expect(title).toContain('text-align:center');
    expect(title).toContain('font-size:28pt');
    const quote = result.body.split('\n').find((l) => l.includes('Neque porro')) ?? '';
    expect(quote).toContain('font-style:italic');
    expect(quote).toContain('color:#404040');
    expect(quote).toContain('text-align:center');
    const bodyPara = result.body.split('\n').find((l) => l.includes('Curabitur')) ?? '';
    expect(bodyPara).toContain('font-size:12pt');
    expect(bodyPara).toContain('text-align:justify');
    expect(bodyPara).toContain('padding-bottom:8pt'); // 160 twips after
    // font-family values must never break the surrounding style="..." attribute
    for (const line of result.body.split('\n')) expect((line.match(/style="/g) ?? []).length).toBe((line.match(/<(p|span|td|table|tr|img)\b/g) ?? []).length);
  });
});

describe('DOCX fidelity: formatting model', () => {
  it('applies direct run and paragraph formatting', async () => {
    const r = await html({
      body: para(
        run('Hello ', '<w:rFonts w:ascii="Georgia"/><w:sz w:val="32"/><w:b/><w:i/><w:u w:val="single"/><w:color w:val="C00000"/>') + run('mark', '<w:highlight w:val="yellow"/><w:strike/>'),
        '<w:jc w:val="right"/><w:spacing w:before="240" w:after="120" w:line="360" w:lineRule="auto"/><w:ind w:left="720" w:firstLine="360"/><w:shd w:val="clear" w:fill="EEEEEE"/>',
      ),
    });
    expect(r.body).toContain('font-family:\'Georgia\', serif');
    expect(r.body).toContain('font-size:16pt');
    expect(r.body).toContain('font-weight:bold');
    expect(r.body).toContain('font-style:italic');
    expect(r.body).toContain('text-decoration:underline');
    expect(r.body).toContain('color:#C00000');
    expect(r.body).toContain('background-color:#ffff00');
    expect(r.body).toContain('line-through');
    expect(r.body).toContain('text-align:right');
    expect(r.body).toContain('padding-top:12pt');
    expect(r.body).toContain('padding-bottom:6pt');
    expect(r.body).toContain('margin-left:36pt');
    expect(r.body).toContain('text-indent:18pt');
    expect(r.body).toContain('background-color:#EEEEEE');
  });

  it('resolves document defaults and style inheritance (basedOn chains, character styles)', async () => {
    const styles =
      '<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Arial"/><w:sz w:val="20"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="200"/></w:pPr></w:pPrDefault></w:docDefaults>' +
      '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>' +
      '<w:style w:type="paragraph" w:styleId="Base"><w:basedOn w:val="Normal"/><w:pPr><w:jc w:val="center"/></w:pPr><w:rPr><w:color w:val="0000FF"/></w:rPr></w:style>' +
      '<w:style w:type="paragraph" w:styleId="Child"><w:basedOn w:val="Base"/><w:rPr><w:b/><w:sz w:val="40"/></w:rPr></w:style>' +
      '<w:style w:type="character" w:styleId="Strong"><w:rPr><w:b/><w:i/></w:rPr></w:style>';
    const r = await html({
      styles,
      body: para(run('Inherited'), '<w:pStyle w:val="Child"/>') + para(run('Plain ') + run('strong', '<w:rStyle w:val="Strong"/>')),
    });
    const [first, second] = r.body.split('\n');
    expect(first).toContain("font-family:'Arial'");
    expect(first).toContain('font-size:20pt');
    expect(first).toContain('font-weight:bold');
    expect(first).toContain('color:#0000FF');
    expect(first).toContain('text-align:center'); // two levels up
    expect(first).toContain('padding-bottom:10pt'); // from docDefaults
    expect(second).toContain('font-size:10pt');
    expect(second).toContain('font-style:italic'); // character style on the second run
  });

  it('numbers lists like Word: decimal, nested levels, restarts and bullets', async () => {
    const numbering =
      '<w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr></w:lvl>' +
      '<w:lvl w:ilvl="1"><w:start w:val="1"/><w:numFmt w:val="lowerLetter"/><w:lvlText w:val="%2)"/><w:pPr><w:ind w:left="1440" w:hanging="360"/></w:pPr></w:lvl></w:abstractNum>' +
      '<w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/><w:lvlText w:val=""/><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr></w:lvl></w:abstractNum>' +
      '<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num><w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>';
    const li = (t: string, id: number, lvl = 0) => para(run(t), `<w:numPr><w:ilvl w:val="${lvl}"/><w:numId w:val="${id}"/></w:numPr>`);
    const r = await html({ numbering, body: li('one', 1) + li('two', 1) + li('two-a', 1, 1) + li('two-b', 1, 1) + li('three', 1) + li('dot', 2) });
    const markers = [...r.body.matchAll(/min-width:[\d.]+pt[^>]*>([^<]*)<\/span>/g)].map((m) => m[1]);
    expect(markers).toEqual(['1.', '2.', 'a)', 'b)', '3.', '•']);
    expect(r.body).toContain('margin-left:36pt');
    expect(r.body).toContain('min-width:18pt');
  });

  it('builds tables with grid widths, merges, borders, shading and table-style header rows', async () => {
    const styles =
      '<w:style w:type="table" w:styleId="Fancy"><w:name w:val="Fancy"/><w:tblPr><w:tblBorders><w:top w:val="single" w:sz="8" w:color="FF0000"/><w:insideH w:val="single" w:sz="4" w:color="00FF00"/></w:tblBorders></w:tblPr>' +
      '<w:tblStylePr w:type="firstRow"><w:rPr><w:b/><w:color w:val="FFFFFF"/></w:rPr><w:tcPr><w:shd w:val="clear" w:fill="1F4E79"/></w:tcPr></w:tblStylePr></w:style>';
    const cell = (t: string, tcPr = '') => `<w:tc>${tcPr ? `<w:tcPr>${tcPr}</w:tcPr>` : ''}${para(run(t))}</w:tc>`;
    const table =
      '<w:tbl><w:tblPr><w:tblStyle w:val="Fancy"/><w:tblW w:w="0" w:type="auto"/><w:tblLook w:val="04A0"/></w:tblPr><w:tblGrid><w:gridCol w:w="2000"/><w:gridCol w:w="3000"/></w:tblGrid>' +
      `<w:tr>${cell('Head A')}${cell('Head B')}</w:tr>` +
      `<w:tr>${cell('merged', '<w:vMerge w:val="restart"/><w:shd w:val="clear" w:fill="FFFF99"/>')}${cell('b1')}</w:tr>` +
      `<w:tr>${cell('', '<w:vMerge/>')}${cell('b2')}</w:tr>` +
      `<w:tr>${cell('wide', '<w:gridSpan w:val="2"/>')}</w:tr></w:tbl>`;
    const r = await html({ styles, body: table });
    expect(r.body).toContain('<col style="width:100pt">');
    expect(r.body).toContain('<col style="width:150pt">');
    expect(r.body).toContain('rowspan="2"');
    expect(r.body).toContain('colspan="2"');
    expect(r.body).toContain('background-color:#FFFF99');
    // header row from the table style: shading + bold white text
    const headRow = r.body.slice(r.body.indexOf('<tr>'), r.body.indexOf('</tr>'));
    expect(headRow).toContain('background-color:#1F4E79');
    expect(headRow).toContain('font-weight:bold');
    expect(headRow).toContain('color:#FFFFFF');
    expect(headRow).toContain('border-top:1pt solid #FF0000');
    expect(r.body).toContain('border-top:0.5pt solid #00FF00'); // inside horizontal lines
    expect((r.body.match(/merged/g) ?? []).length).toBe(1);
  });

  it('embeds pictures at their Word size and refuses unsupported ones with a warning', async () => {
    const png = await buildTransparentPng(8);
    const drawing = (rid: string) =>
      `<w:r><w:drawing><wp:inline><wp:extent cx="1270000" cy="635000"/><wp:docPr id="1" name="p" descr="A tiny picture"/><a:graphic><a:graphicData><pic:pic><pic:blipFill><a:blip r:embed="${rid}"/></pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`;
    const rels =
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/a.png"/>' +
      '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/b.emf"/>';
    const r = await html({ rels, media: { 'a.png': png, 'b.emf': Buffer.from('emf') }, body: para(drawing('rId1') + drawing('rId2')) });
    expect(r.body).toContain('src="data:image/png;base64,');
    expect(r.body).toContain('width:100pt;height:50pt');
    expect(r.body).toContain('alt="A tiny picture"');
    expect((r.body.match(/<img/g) ?? []).length).toBe(1);
    expect(r.warnings.join(' ')).toMatch(/format that is not supported/);
  });

  it('only links http(s) and mailto targets', async () => {
    const link = (id: string, t: string) => `<w:hyperlink r:id="${id}">${run(t)}</w:hyperlink>`;
    const rels =
      '<Relationship Id="rId1" Type="x/hyperlink" Target="https://example.com/a?b=1&amp;c=2" TargetMode="External"/>' +
      '<Relationship Id="rId2" Type="x/hyperlink" Target="javascript:alert(1)" TargetMode="External"/>' +
      '<Relationship Id="rId3" Type="x/hyperlink" Target="file:///etc/passwd" TargetMode="External"/>';
    const r = await html({ rels, body: para(link('rId1', 'ok') + link('rId2', 'js') + link('rId3', 'file')) });
    expect(r.body).toContain('<a href="https://example.com/a?b=1&amp;c=2">');
    expect(r.body).not.toContain('javascript:');
    expect(r.body).not.toContain('file:');
    expect(r.body).toContain('js');
  });

  it('hides hidden text, skips deletions, keeps insertions, and reports unsupported parts', async () => {
    const r = await html({
      body: para(run('visible ') + run('hidden', '<w:vanish/>') + '<w:del><w:r><w:delText>removed</w:delText></w:r></w:del><w:ins>' + run('inserted') + '</w:ins>') + para('<w:r><w:pict/></w:r>'),
    });
    expect(r.body).toContain('visible');
    expect(r.body).toContain('inserted');
    expect(r.body).not.toContain('hidden');
    expect(r.body).not.toContain('removed');
    expect(r.warnings.join(' ')).toMatch(/text boxes, shapes/);
  });

  it('switches to landscape and reads custom margins; falls back safely for nonsense', async () => {
    const sect = (inner: string) => `<w:sectPr>${inner}</w:sectPr>`;
    const landscape = await html({ body: para(run('x')) + sect('<w:pgSz w:w="12240" w:h="15840" w:orient="landscape"/><w:pgMar w:top="720" w:right="1080" w:bottom="720" w:left="1080"/>') });
    expect(landscape.page).toEqual({ widthPt: 792, heightPt: 612, top: 36, right: 54, bottom: 36, left: 54 });
    const absurd = await html({ body: para(run('x')) + sect('<w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="9000" w:bottom="1440" w:left="9000"/>') });
    expect(absurd.page).toMatchObject({ left: 72, right: 72 });
    const none = await html({ body: para(run('x')) });
    expect(none.page).toBeNull();
  });

  it('escapes document text so it can never become markup', async () => {
    const r = await html({ body: para(run('&lt;img src=x onerror=alert(1)&gt; &amp;amp; "quotes"')) });
    expect(r.body).not.toContain('<img');
    expect(r.body).toContain('&lt;img src=x onerror=alert(1)&gt; &amp;amp;');
  });
});

describe('DOCX safety', () => {
  it('refuses a ZIP that would expand to an unreasonable size (decompression bomb)', async () => {
    const dir = await makeTempDir('bomb');
    const big = path.join(dir, 'zeros.bin');
    const handle = await fs.open(big, 'w');
    await handle.truncate(600 * 1024 * 1024);
    await handle.close();
    const file = path.join(dir, 'bomb.docx');
    const zip = new yazl.ZipFile();
    zip.addFile(big, 'word/document.xml');
    zip.end();
    await pipeline(zip.outputStream, createWriteStream(file));
    expect((await fs.stat(file)).size).toBeLessThan(5 * 1024 * 1024);
    await expect(docxToHtml(file)).rejects.toMatchObject({ code: 'CORRUPT_INPUT' });
  }, 120_000);

  it('survives an XML entity-expansion attack without hanging or exhausting memory', async () => {
    const dir = await makeTempDir('xxe');
    const file = path.join(dir, 'laughs.docx');
    const lol = '<!DOCTYPE d [<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;"><!ENTITY c "&b;&b;&b;&b;&b;&b;&b;&b;&b;&b;"><!ENTITY d "&c;&c;&c;&c;&c;&c;&c;&c;&c;&c;"><!ENTITY e "&d;&d;&d;&d;&d;&d;&d;&d;&d;&d;"><!ENTITY f "&e;&e;&e;&e;&e;&e;&e;&e;&e;&e;">]>';
    await writeCustomDocx(file, { body: '<w:p><w:r><w:t>&f;&f;&f;&f;&f;&f;&f;&f;</w:t></w:r></w:p>' });
    // Inject the DOCTYPE into document.xml.
    const { writeZipFile } = await import('../helpers/fixtures');
    await writeZipFile(file, [
      { name: '[Content_Types].xml', data: '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>' },
      { name: 'word/document.xml', data: `<?xml version="1.0"?>${lol}<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>&f;&f;&f;&f;&f;&f;&f;&f;</w:t></w:r></w:p></w:body></w:document>` },
    ]);
    const started = Date.now();
    const outcome = await docxToHtml(file).then((r) => ({ ok: true as const, length: r.body.length }), (e: unknown) => ({ ok: false as const, e }));
    expect(Date.now() - started).toBeLessThan(10_000);
    if (outcome.ok) expect(outcome.length).toBeLessThan(5_000_000); // either rejected or kept small
  }, 60_000);
});
