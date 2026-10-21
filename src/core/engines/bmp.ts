import { MorphError } from '../../shared/errors';
import { MAX_INPUT_PIXELS } from './types';

export interface RawImage {
  width: number;
  height: number;
  /** RGBA, 4 bytes per pixel, top-down. */
  rgba: Buffer;
}

function corrupt(detail: string): MorphError {
  return new MorphError('CORRUPT_INPUT', 'The BMP image is damaged or uses an unsupported variant.', { detail });
}

function countTrailingZeros(mask: number): number {
  if (mask === 0) return 0;
  let n = 0;
  while (((mask >>> n) & 1) === 0) n += 1;
  return n;
}

function scaleTo8(value: number, bits: number): number {
  if (bits <= 0) return 0;
  if (bits === 8) return value;
  return Math.round((value * 255) / ((1 << bits) - 1));
}

function popcount(mask: number): number {
  let n = 0;
  let m = mask >>> 0;
  while (m) {
    n += m & 1;
    m >>>= 1;
  }
  return n;
}

/**
 * Decodes a DIB (the part of a BMP after the 14-byte file header, also used inside ICO files).
 * Supports 1/4/8-bit palettes, 16/24/32-bit RGB and BITFIELDS. RLE and embedded JPEG/PNG are refused.
 *
 * @param pixelOffset byte offset of the pixel array inside `dib`; null = directly after header and palette
 * @param isIcon      when true the height field covers the XOR bitmap and the AND mask (ICO convention)
 */
export function decodeDib(dib: Buffer, pixelOffset: number | null, isIcon: boolean): RawImage {
  if (dib.length < 12) throw corrupt('DIB header truncated');
  const headerSize = dib.readUInt32LE(0);
  let width: number;
  let heightRaw: number;
  let bpp: number;
  let compression = 0;
  let colorsUsed = 0;

  if (headerSize === 12) {
    width = dib.readUInt16LE(4);
    heightRaw = dib.readInt16LE(6);
    bpp = dib.readUInt16LE(10);
  } else if (headerSize >= 40) {
    if (dib.length < 40) throw corrupt('DIB header truncated');
    width = dib.readInt32LE(4);
    heightRaw = dib.readInt32LE(8);
    bpp = dib.readUInt16LE(14);
    compression = dib.readUInt32LE(16);
    colorsUsed = dib.readUInt32LE(32);
  } else {
    throw corrupt(`Unsupported DIB header size ${headerSize}`);
  }

  const topDown = heightRaw < 0;
  let height = Math.abs(heightRaw);
  if (isIcon) height = Math.floor(height / 2);
  if (width <= 0 || height <= 0) throw corrupt('Invalid dimensions');
  if (width * height > MAX_INPUT_PIXELS) {
    throw new MorphError('INPUT_TOO_LARGE', 'The image has too many pixels to convert safely.', { detail: `${width}x${height}` });
  }
  if (![1, 4, 8, 16, 24, 32].includes(bpp)) throw corrupt(`Unsupported bit depth ${bpp}`);
  if (compression === 1 || compression === 2) throw new MorphError('UNSUPPORTED_FORMAT', 'RLE-compressed BMP images are not supported.');
  if (compression === 4 || compression === 5) throw new MorphError('UNSUPPORTED_FORMAT', 'BMP files with embedded JPEG or PNG data are not supported.');
  if (compression !== 0 && compression !== 3 && compression !== 6) throw corrupt(`Unsupported compression ${compression}`);

  // Colour masks
  let masks: { r: number; g: number; b: number; a: number } | null = null;
  let maskBytes = 0;
  if (compression === 3 || compression === 6) {
    if (headerSize >= 52) {
      masks = { r: dib.readUInt32LE(40), g: dib.readUInt32LE(44), b: dib.readUInt32LE(48), a: headerSize >= 56 ? dib.readUInt32LE(52) : 0 };
    } else {
      maskBytes = compression === 6 ? 16 : 12;
      if (dib.length < headerSize + maskBytes) throw corrupt('Colour masks truncated');
      masks = {
        r: dib.readUInt32LE(headerSize),
        g: dib.readUInt32LE(headerSize + 4),
        b: dib.readUInt32LE(headerSize + 8),
        a: compression === 6 ? dib.readUInt32LE(headerSize + 12) : 0,
      };
    }
  } else if (bpp === 16) {
    masks = { r: 0x7c00, g: 0x03e0, b: 0x001f, a: 0 };
  } else if (bpp === 32) {
    masks = { r: 0x00ff0000, g: 0x0000ff00, b: 0x000000ff, a: 0xff000000 };
  }
  if ((bpp === 16 || bpp === 32) && !masks) throw corrupt('Missing colour masks');

  // Palette
  let palette: Buffer | null = null;
  let paletteEntries = 0;
  let paletteStride = 4;
  if (bpp <= 8) {
    paletteEntries = colorsUsed > 0 ? colorsUsed : 1 << bpp;
    paletteEntries = Math.min(paletteEntries, 1 << bpp);
    paletteStride = headerSize === 12 ? 3 : 4;
    const paletteStart = headerSize + maskBytes;
    const paletteLength = paletteEntries * paletteStride;
    if (dib.length < paletteStart + paletteLength) throw corrupt('Palette truncated');
    palette = dib.subarray(paletteStart, paletteStart + paletteLength);
  }

  const start = pixelOffset ?? headerSize + maskBytes + paletteEntries * paletteStride;
  const stride = Math.floor((bpp * width + 31) / 32) * 4;
  const pixelBytes = stride * height;
  if (start < 0 || start + pixelBytes > dib.length) throw corrupt('Pixel data truncated');

  const rgba = Buffer.alloc(width * height * 4);
  let anyAlpha = false;

  const rShift = masks ? countTrailingZeros(masks.r) : 0;
  const gShift = masks ? countTrailingZeros(masks.g) : 0;
  const bShift = masks ? countTrailingZeros(masks.b) : 0;
  const aShift = masks ? countTrailingZeros(masks.a) : 0;
  const rBits = masks ? popcount(masks.r) : 0;
  const gBits = masks ? popcount(masks.g) : 0;
  const bBits = masks ? popcount(masks.b) : 0;
  const aBits = masks ? popcount(masks.a) : 0;

  for (let y = 0; y < height; y += 1) {
    const srcRow = start + (topDown ? y : height - 1 - y) * stride;
    let dst = y * width * 4;
    for (let x = 0; x < width; x += 1, dst += 4) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 255;
      if (bpp === 24) {
        const o = srcRow + x * 3;
        b = dib[o] ?? 0;
        g = dib[o + 1] ?? 0;
        r = dib[o + 2] ?? 0;
      } else if (bpp === 32 || bpp === 16) {
        const o = srcRow + x * (bpp / 8);
        const px = bpp === 32 ? dib.readUInt32LE(o) : dib.readUInt16LE(o);
        // masks is non-null for 16/32 bpp (checked above)
        r = scaleTo8((px & (masks?.r ?? 0)) >>> rShift, rBits);
        g = scaleTo8((px & (masks?.g ?? 0)) >>> gShift, gBits);
        b = scaleTo8((px & (masks?.b ?? 0)) >>> bShift, bBits);
        if (aBits > 0) {
          a = scaleTo8((px & (masks?.a ?? 0)) >>> aShift, aBits);
          if (a !== 0) anyAlpha = true;
        }
      } else {
        const bitOffset = x * bpp;
        const byte = dib[srcRow + (bitOffset >> 3)] ?? 0;
        const shift = 8 - bpp - (bitOffset & 7);
        const index = (byte >> shift) & ((1 << bpp) - 1);
        if (palette && index < paletteEntries) {
          const po = index * paletteStride;
          b = palette[po] ?? 0;
          g = palette[po + 1] ?? 0;
          r = palette[po + 2] ?? 0;
        }
      }
      rgba[dst] = r;
      rgba[dst + 1] = g;
      rgba[dst + 2] = b;
      rgba[dst + 3] = a;
    }
  }

  // 32-bit BMPs very often carry an unused (all-zero) alpha byte: treat those as opaque.
  if (bpp === 32 && aBits > 0 && !anyAlpha) {
    for (let i = 3; i < rgba.length; i += 4) rgba[i] = 255;
  }

  // ICO transparency: 1-bit AND mask after the XOR bitmap (only meaningful when there is no real alpha).
  if (isIcon && !(bpp === 32 && anyAlpha)) {
    const maskStride = Math.floor((width + 31) / 32) * 4;
    const maskStart = start + pixelBytes;
    if (maskStart + maskStride * height <= dib.length) {
      for (let y = 0; y < height; y += 1) {
        const srcRow = maskStart + (topDown ? y : height - 1 - y) * maskStride;
        for (let x = 0; x < width; x += 1) {
          const bit = ((dib[srcRow + (x >> 3)] ?? 0) >> (7 - (x & 7))) & 1;
          if (bit === 1) rgba[(y * width + x) * 4 + 3] = 0;
        }
      }
    }
  }

  return { width, height, rgba };
}

export function decodeBmp(buf: Buffer): RawImage {
  if (buf.length < 26 || buf.toString('latin1', 0, 2) !== 'BM') throw corrupt('Missing BMP signature');
  const dataOffset = buf.readUInt32LE(10);
  const dib = buf.subarray(14);
  return decodeDib(dib, dataOffset >= 14 ? dataOffset - 14 : null, false);
}

/** Encodes 8-bit RGB pixels (3 bytes each, top-down) as an uncompressed 24-bit BMP. */
export function encodeBmp24(rgb: Buffer, width: number, height: number): Buffer {
  const stride = Math.floor((24 * width + 31) / 32) * 4;
  const pixelBytes = stride * height;
  const fileSize = 54 + pixelBytes;
  if (fileSize > 0xffffffff) throw new MorphError('INPUT_TOO_LARGE', 'The image is too large to save as a BMP file.');
  const out = Buffer.alloc(fileSize);
  out.write('BM', 0, 'latin1');
  out.writeUInt32LE(fileSize, 2);
  out.writeUInt32LE(54, 10);
  out.writeUInt32LE(40, 14);
  out.writeInt32LE(width, 18);
  out.writeInt32LE(height, 22);
  out.writeUInt16LE(1, 26);
  out.writeUInt16LE(24, 28);
  out.writeUInt32LE(0, 30);
  out.writeUInt32LE(pixelBytes, 34);
  out.writeInt32LE(2835, 38);
  out.writeInt32LE(2835, 42);
  for (let y = 0; y < height; y += 1) {
    let src = y * width * 3;
    let dst = 54 + (height - 1 - y) * stride;
    for (let x = 0; x < width; x += 1, src += 3, dst += 3) {
      out[dst] = rgb[src + 2] ?? 0;
      out[dst + 1] = rgb[src + 1] ?? 0;
      out[dst + 2] = rgb[src] ?? 0;
    }
  }
  return out;
}
