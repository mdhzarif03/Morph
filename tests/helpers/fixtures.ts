import { createWriteStream, promises as fs } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import yazl from 'yazl';
import sharp from 'sharp';

/** Builds a valid multi-page PDF with a visible label on each page. No external tools needed. */
export function buildPdf(pageCount: number, options: { width?: number; height?: number; label?: string } = {}): Buffer {
  const { width = 300, height = 400, label = 'Morph test page' } = options;
  const objects: string[] = [];
  const add = (body: string): number => {
    objects.push(body);
    return objects.length;
  };
  const catalog = add('<< /Type /Catalog /Pages 2 0 R >>');
  const pagesId = add('PLACEHOLDER');
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const kids: number[] = [];
  for (let i = 1; i <= pageCount; i += 1) {
    const content = `BT /F1 28 Tf 30 ${Math.round(height / 2)} Td (${label} ${i}) Tj ET`;
    const contentId = add(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
    const pageId = add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${width} ${height}] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${contentId} 0 R >>`);
    kids.push(pageId);
  }
  objects[pagesId - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${pageCount} >>`;

  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(Buffer.byteLength(out, 'latin1'));
    out += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefAt = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) out += `${String(offset).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

async function writeZip(destination: string, entries: Array<{ name: string; data: string; store?: boolean }>): Promise<void> {
  const zip = new yazl.ZipFile();
  for (const entry of entries) zip.addBuffer(Buffer.from(entry.data, 'utf8'), entry.name, { compress: !entry.store });
  zip.end();
  await pipeline(zip.outputStream, createWriteStream(destination));
}

const escapeXml = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export async function writeDocx(destination: string, paragraphs: string[]): Promise<void> {
  const body = paragraphs.map((p) => `<w:p><w:r><w:t xml:space="preserve">${escapeXml(p)}</w:t></w:r></w:p>`).join('');
  await writeZip(destination, [
    { name: '[Content_Types].xml', data: '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>' },
    { name: '_rels/.rels', data: '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>' },
    { name: 'word/document.xml', data: `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}<w:sectPr/></w:body></w:document>` },
  ]);
}

export async function writeOdt(destination: string, paragraphs: string[]): Promise<void> {
  const body = paragraphs.map((p) => `<text:p>${escapeXml(p)}</text:p>`).join('');
  await writeZip(destination, [
    { name: 'mimetype', data: 'application/vnd.oasis.opendocument.text', store: true },
    { name: 'META-INF/manifest.xml', data: '<?xml version="1.0" encoding="UTF-8"?><manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.2"><manifest:file-entry manifest:full-path="/" manifest:media-type="application/vnd.oasis.opendocument.text"/><manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/></manifest:manifest>' },
    { name: 'content.xml', data: `<?xml version="1.0" encoding="UTF-8"?><office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" office:version="1.2"><office:body><office:text>${body}</office:text></office:body></office:document-content>` },
  ]);
}

/** A mono 16-bit PCM WAV containing a sine tone. */
export function buildWav(seconds = 1, sampleRate = 22050, frequency = 440): Buffer {
  const samples = Math.round(seconds * sampleRate);
  const data = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i += 1) data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * frequency * i) / sampleRate) * 12000), i * 2);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'latin1');
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVEfmt ', 8, 'latin1');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'latin1');
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

/** A PNG with a semi-transparent red square on a transparent background. */
export async function buildTransparentPng(size = 64): Promise<Buffer> {
  const rgba = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const inside = x > size / 4 && x < (size * 3) / 4 && y > size / 4 && y < (size * 3) / 4;
      const o = (y * size + x) * 4;
      rgba[o] = 255;
      rgba[o + 1] = 0;
      rgba[o + 2] = 0;
      rgba[o + 3] = inside ? 255 : 0;
    }
  }
  return sharp(rgba, { raw: { width: size, height: size, channels: 4 } }).png().toBuffer();
}

export async function buildGradientImage(width: number, height: number, format: 'png' | 'jpeg' | 'webp' | 'tiff' | 'avif' | 'gif' = 'png'): Promise<Buffer> {
  const rgb = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const o = (y * width + x) * 3;
      rgb[o] = Math.round((x / Math.max(1, width - 1)) * 255);
      rgb[o + 1] = Math.round((y / Math.max(1, height - 1)) * 255);
      rgb[o + 2] = 128;
    }
  }
  return sharp(rgb, { raw: { width, height, channels: 3 } }).toFormat(format).toBuffer();
}

/** A 3-frame animated GIF (red, green, blue frames), built by joining three single-frame images. */
export async function buildAnimatedGif(width = 32, height = 32): Promise<Buffer> {
  const colors = [
    { r: 255, g: 0, b: 0 },
    { r: 0, g: 255, b: 0 },
    { r: 0, g: 0, b: 255 },
  ];
  const frames = await Promise.all(colors.map((background) => sharp({ create: { width, height, channels: 3, background } }).png().toBuffer()));
  return sharp(frames, { join: { animated: true } })
    .gif({ delay: [100, 100, 100], loop: 0 })
    .toBuffer();
}

export async function writeFile(destination: string, data: Buffer | string): Promise<string> {
  await fs.writeFile(destination, data);
  return destination;
}
