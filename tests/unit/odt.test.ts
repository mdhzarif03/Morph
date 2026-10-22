import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { odtToHtml } from '../../src/core/engines/docs/odt';
import { writeZipFile } from '../helpers/fixtures';
import { makeTempDir } from '../helpers/env';

const NS =
  'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0"';

async function odt(content: string, styles = ''): Promise<Awaited<ReturnType<typeof odtToHtml>>> {
  const dir = await makeTempDir('odt');
  const file = path.join(dir, 't.odt');
  await writeZipFile(file, [
    { name: 'mimetype', data: 'application/vnd.oasis.opendocument.text', store: true },
    { name: 'content.xml', data: `<?xml version="1.0"?><office:document-content ${NS}><office:automatic-styles>${styles}</office:automatic-styles><office:body><office:text>${content}</office:text></office:body></office:document-content>` },
    {
      name: 'styles.xml',
      data: `<?xml version="1.0"?><office:document-styles ${NS}><office:font-face-decls><style:font-face style:name="Liberation Serif" svg:font-family="'Liberation Serif'"/></office:font-face-decls><office:styles><style:default-style style:family="paragraph"><style:text-properties style:font-name="Liberation Serif" fo:font-size="12pt"/></style:default-style><style:style style:name="Title" style:family="paragraph"><style:paragraph-properties fo:text-align="center" fo:margin-bottom="6pt"/><style:text-properties fo:font-size="24pt" fo:font-weight="bold" fo:color="#1f4e79"/></style:style><style:style style:name="Sub" style:family="paragraph" style:parent-style-name="Title"><style:text-properties fo:font-size="14pt"/></style:style></office:styles><office:automatic-styles><style:page-layout style:name="pm1"><style:page-layout-properties fo:page-width="21.59cm" fo:page-height="27.94cm" fo:margin-top="2.54cm" fo:margin-bottom="2.54cm" fo:margin-left="2.54cm" fo:margin-right="2.54cm"/></style:page-layout></office:automatic-styles></office:document-styles>`,
    },
  ]);
  return odtToHtml(file);
}

describe('ODT fidelity', () => {
  it('applies default fonts, inherited paragraph styles, colours and alignment', async () => {
    const r = await odt('<text:p text:style-name="Title">Heading</text:p><text:p text:style-name="Sub">Sub</text:p><text:p>Body</text:p>');
    const [title, sub, body] = r.html.split('\n');
    expect(title).toContain('text-align:center');
    expect(title).toContain('font-size:24pt');
    expect(title).toContain('font-weight:bold');
    expect(title).toContain('color:#1f4e79');
    expect(title).toContain("'Liberation Serif'");
    expect(title).toContain('padding-bottom:6pt');
    expect(sub).toContain('font-size:14pt'); // overrides the parent's 24pt
    expect(sub).toContain('text-align:center'); // inherited
    expect(body).toContain('font-size:12pt');
    expect(body).not.toContain('text-align');
  });

  it('reads the page size and margins from the page layout', async () => {
    const r = await odt('<text:p>x</text:p>');
    expect(r.page?.widthPt).toBeCloseTo(612, 0);
    expect(r.page?.heightPt).toBeCloseTo(792, 0);
    expect(r.page?.left).toBeCloseTo(72, 0);
  });

  it('applies span formatting and tells ordered from bullet lists', async () => {
    const styles = '<style:style style:name="T1" style:family="text"><style:text-properties fo:font-style="italic" fo:color="#ff0000"/></style:style><text:list-style style:name="L1"><text:list-level-style-number text:level="1"/></text:list-style>';
    const r = await odt('<text:p>a <text:span text:style-name="T1">red</text:span></text:p><text:list text:style-name="L1"><text:list-item><text:p>one</text:p></text:list-item></text:list>', styles);
    expect(r.html).toMatch(/<span style="[^"]*font-style:italic[^"]*color:#ff0000[^"]*">red<\/span>/);
    expect(r.html).toContain('<ol');
  });

  it('keeps zero-padded and numeric-looking text intact', async () => {
    const r = await odt('<text:p>007</text:p><text:p>1e3</text:p>');
    expect(r.html).toContain('>007<');
    expect(r.html).toContain('>1e3<');
  });
});
