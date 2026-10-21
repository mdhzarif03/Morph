import { MorphError } from '../../shared/errors';
import { decodeDib, type RawImage } from './bmp';

export type IcoImage = { kind: 'png'; data: Buffer } | { kind: 'raw'; image: RawImage };

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

interface IconEntry {
  width: number;
  height: number;
  offset: number;
  length: number;
}

function readEntries(buf: Buffer): IconEntry[] {
  if (buf.length < 6 || buf.readUInt16LE(0) !== 0 || buf.readUInt16LE(2) !== 1) {
    throw new MorphError('CORRUPT_INPUT', 'The icon file is damaged.', { detail: 'Bad ICONDIR' });
  }
  const count = buf.readUInt16LE(4);
  if (count === 0 || buf.length < 6 + count * 16) {
    throw new MorphError('CORRUPT_INPUT', 'The icon file is damaged.', { detail: 'Bad entry count' });
  }
  const entries: IconEntry[] = [];
  for (let i = 0; i < count; i += 1) {
    const base = 6 + i * 16;
    const width = buf[base] === 0 ? 256 : (buf[base] ?? 0);
    const height = buf[base + 1] === 0 ? 256 : (buf[base + 1] ?? 0);
    const length = buf.readUInt32LE(base + 8);
    const offset = buf.readUInt32LE(base + 12);
    if (offset + length > buf.length || length === 0) continue; // ignore entries pointing outside the file
    entries.push({ width, height, offset, length });
  }
  if (entries.length === 0) throw new MorphError('CORRUPT_INPUT', 'The icon file is damaged.', { detail: 'No valid entries' });
  return entries;
}

/** Picks the largest image inside an ICO file. */
export function decodeIcoLargest(buf: Buffer): IcoImage {
  const entries = readEntries(buf);
  const best = entries.reduce((a, b) => (b.width * b.height > a.width * a.height ? b : a));
  const data = buf.subarray(best.offset, best.offset + best.length);
  if (data.subarray(0, 8).equals(PNG_SIGNATURE)) return { kind: 'png', data };
  return { kind: 'raw', image: decodeDib(data, null, true) };
}

export function icoLargestSize(buf: Buffer): { width: number; height: number } {
  const entries = readEntries(buf);
  const best = entries.reduce((a, b) => (b.width * b.height > a.width * a.height ? b : a));
  return { width: best.width, height: best.height };
}

/** Builds an ICO file from PNG-encoded images (supported by Windows Vista and later). */
export function encodeIco(images: Array<{ size: number; png: Buffer }>): Buffer {
  if (images.length === 0 || images.length > 255) throw new MorphError('INTERNAL', 'Invalid icon image count.');
  const headerSize = 6 + images.length * 16;
  const total = headerSize + images.reduce((sum, i) => sum + i.png.length, 0);
  const out = Buffer.alloc(total);
  out.writeUInt16LE(0, 0);
  out.writeUInt16LE(1, 2);
  out.writeUInt16LE(images.length, 4);
  let offset = headerSize;
  images.forEach((image, index) => {
    const base = 6 + index * 16;
    out[base] = image.size >= 256 ? 0 : image.size;
    out[base + 1] = image.size >= 256 ? 0 : image.size;
    out[base + 2] = 0;
    out[base + 3] = 0;
    out.writeUInt16LE(1, base + 4);
    out.writeUInt16LE(32, base + 6);
    out.writeUInt32LE(image.png.length, base + 8);
    out.writeUInt32LE(offset, base + 12);
    image.png.copy(out, offset);
    offset += image.png.length;
  });
  return out;
}
