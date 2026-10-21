import { promises as fs } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { detectFile } from '../../src/core/detect';
import { buildAnimatedGif, buildGradientImage, buildPdf, buildWav, writeDocx, writeOdt } from '../helpers/fixtures';
import { makeTempDir } from '../helpers/env';

async function detect(name: string, data: Buffer | string) {
  const dir = await makeTempDir('detect');
  const file = path.join(dir, name);
  await fs.writeFile(file, data);
  return detectFile(file);
}

describe('content-based file type detection', () => {
  it.each([
    ['png', 'image.png', 'png'],
    ['jpeg', 'image.jpg', 'jpeg'],
    ['webp', 'image.webp', 'webp'],
    ['tiff', 'image.tif', 'tiff'],
    ['avif', 'image.avif', 'avif'],
  ] as const)('identifies %s by its signature', async (_label, name, sharpFormat) => {
    const result = await detect(name, await buildGradientImage(16, 16, sharpFormat));
    expect(result.format).toBe(name.endsWith('tif') ? 'tiff' : name.endsWith('jpg') ? 'jpg' : sharpFormat);
    expect(result.extensionMismatch).toBe(false);
  });

  it('identifies GIF, PDF, WAV', async () => {
    expect((await detect('a.gif', await buildAnimatedGif())).format).toBe('gif');
    expect((await detect('a.pdf', buildPdf(1))).format).toBe('pdf');
    expect((await detect('a.wav', buildWav(1))).format).toBe('wav');
  });

  it('identifies DOCX and ODT inside ZIP containers, and refuses other ZIP-based files', async () => {
    const dir = await makeTempDir('detect');
    await writeDocx(path.join(dir, 'a.docx'), ['x']);
    await writeOdt(path.join(dir, 'a.odt'), ['x']);
    expect((await detectFile(path.join(dir, 'a.docx'))).format).toBe('docx');
    expect((await detectFile(path.join(dir, 'a.odt'))).format).toBe('odt');
    // A plain ZIP is an archive, not a document
    const zip = await detect('x.docx', Buffer.from('504b0506' + '00'.repeat(18), 'hex'));
    expect(zip.format).toBeNull();
  });

  it('does not trust the extension: a PNG named .jpg is detected as PNG and flagged', async () => {
    const result = await detect('holiday.jpg', await buildGradientImage(8, 8, 'png'));
    expect(result.format).toBe('png');
    expect(result.extensionMismatch).toBe(true);
    expect(result.notes.join(' ')).toMatch(/named \.jpg but its content is PNG/);
  });

  it('identifies a file with no extension from its content', async () => {
    const result = await detect('mystery', await buildGradientImage(8, 8, 'png'));
    expect(result.format).toBe('png');
    expect(result.extensionMismatch).toBe(true);
  });

  it('accepts alternative extensions of the same format (jpeg, tif) without a mismatch', async () => {
    expect((await detect('a.jpeg', await buildGradientImage(8, 8, 'jpeg'))).extensionMismatch).toBe(false);
    expect((await detect('a.tiff', await buildGradientImage(8, 8, 'tiff'))).extensionMismatch).toBe(false);
  });

  it('rejects text pretending to be media and explains it is unrecognised', async () => {
    const result = await detect('song.mp3', 'I am just a text file '.repeat(30));
    expect(result.format).toBeNull();
    expect(result.unsupportedReason).toBeTruthy();
  });

  it('treats plain .txt as TXT, but other text files as unsupported', async () => {
    expect((await detect('notes.txt', 'hello\nworld\n')).format).toBe('txt');
    expect((await detect('notes.csv', 'a,b\n1,2\n')).format).toBeNull();
    expect((await detect('page.html', '<!DOCTYPE html><html></html>')).format).toBeNull();
    expect((await detect('vector.svg', '<svg xmlns="http://www.w3.org/2000/svg"></svg>')).format).toBeNull();
  });

  it('flags Windows-1252 text and UTF-16 text', async () => {
    const legacy = await detect('old.txt', Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]));
    expect(legacy.format).toBe('txt');
    expect(legacy.notes.join(' ')).toMatch(/Windows-1252/);
    const utf16 = await detect('wide.txt', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('hi there', 'utf16le')]));
    expect(utf16.format).toBe('txt');
  });

  it('refuses executables and unknown binaries rather than guessing', async () => {
    expect((await detect('setup.png', Buffer.concat([Buffer.from('MZ'), Buffer.alloc(200, 1)]))).format).toBeNull();
    expect((await detect('blob.bin', Buffer.alloc(500, 0x07))).format).toBeNull();
  });

  it('tells MP3 (ID3 or bare frames), ADTS AAC, FLAC and Ogg apart', async () => {
    // 128 kbps / 44.1 kHz MPEG-1 Layer III frames are 417 bytes long.
    const mp3Frame = Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0x00]), Buffer.alloc(413)]);
    const id3 = Buffer.concat([Buffer.from('ID3'), Buffer.from([4, 0, 0, 0, 0, 0, 0]), mp3Frame, mp3Frame]);
    expect((await detect('a.mp3', id3)).format).toBe('mp3');
    expect((await detect('b.mp3', Buffer.concat([mp3Frame, mp3Frame, mp3Frame]))).format).toBe('mp3');
    // ADTS frame: 7-byte header declaring a 32-byte frame
    const adts = Buffer.alloc(32);
    Buffer.from([0xff, 0xf1, 0x50, 0x80, 0x04, 0x1f, 0xfc]).copy(adts);
    expect((await detect('c.aac', Buffer.concat([adts, adts, adts]))).format).toBe('aac');
    expect((await detect('d.flac', Buffer.concat([Buffer.from('fLaC'), Buffer.alloc(64)]))).format).toBe('flac');
    expect((await detect('e.ogg', Buffer.concat([Buffer.from('OggS'), Buffer.alloc(64)]))).format).toBe('ogg');
  });

  it('does not mistake random bytes or a lone sync pattern for MP3', async () => {
    expect((await detect('x.mp3', Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0x00]), Buffer.alloc(900, 0x41)]))).format).not.toBe('mp3');
  });

  it('distinguishes MP4 / MOV / M4A / WebM / MKV containers', async () => {
    const ftyp = (brand: string) => {
      const b = Buffer.alloc(32);
      b.writeUInt32BE(32, 0);
      b.write('ftyp', 4, 'latin1');
      b.write(brand, 8, 'latin1');
      return b;
    };
    expect((await detect('a.mp4', ftyp('isom'))).format).toBe('mp4');
    expect((await detect('a.mov', ftyp('qt  '))).format).toBe('mov');
    expect((await detect('a.m4a', ftyp('M4A '))).format).toBe('m4a');
    const ebml = (doc: string) => Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x82, 0x84]), Buffer.from(doc, 'latin1'), Buffer.alloc(32)]);
    expect((await detect('a.webm', ebml('webm'))).format).toBe('webm');
    expect((await detect('a.mkv', ebml('matroska'))).format).toBe('mkv');
  });

  it('reports HEIC as unsupported with a reason', async () => {
    const b = Buffer.alloc(32);
    b.writeUInt32BE(32, 0);
    b.write('ftypheic', 4, 'latin1');
    const result = await detect('photo.heic', b);
    expect(result.format).toBeNull();
    expect(result.unsupportedReason).toMatch(/HEIC/);
  });

  it('reads only the file header, even for a very large file', async () => {
    const dir = await makeTempDir('detect');
    const file = path.join(dir, 'huge.wav');
    const handle = await fs.open(file, 'w');
    await handle.write(buildWav(1).subarray(0, 44));
    await handle.truncate(1024 * 1024 * 1024); // 1 GiB (sparse where supported)
    await handle.close();
    const before = process.memoryUsage().rss;
    const result = await detectFile(file);
    expect(result.format).toBe('wav');
    expect(process.memoryUsage().rss - before).toBeLessThan(50 * 1024 * 1024);
  });
});
