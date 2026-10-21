import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { decodeBmp, encodeBmp24 } from '../../src/core/engines/bmp';
import { decodeIcoLargest, encodeIco, icoLargestSize } from '../../src/core/engines/ico';

describe('BMP codec', () => {
  it('round-trips 24-bit pixels including non-multiple-of-4 widths', () => {
    const w = 5;
    const h = 3;
    const rgb = Buffer.alloc(w * h * 3);
    for (let i = 0; i < rgb.length; i += 1) rgb[i] = (i * 37) % 256;
    const bmp = encodeBmp24(rgb, w, h);
    expect(bmp.subarray(0, 2).toString()).toBe('BM');
    const decoded = decodeBmp(bmp);
    expect(decoded.width).toBe(w);
    expect(decoded.height).toBe(h);
    const px = decoded.rgba;
    for (let i = 0; i < w * h; i += 1) {
      expect([px[i * 4], px[i * 4 + 1], px[i * 4 + 2]]).toEqual([rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2]]);
    }
  });
  it('rejects truncated and absurd headers instead of allocating', () => {
    const bmp = encodeBmp24(Buffer.alloc(12), 2, 2);
    expect(() => decodeBmp(bmp.subarray(0, 20))).toThrow();
    const huge = Buffer.from(bmp);
    huge.writeInt32LE(60000, 18);
    huge.writeInt32LE(60000, 22);
    expect(() => decodeBmp(huge)).toThrow();
    expect(() => decodeBmp(Buffer.from('not a bmp at all'))).toThrow();
  });
});

describe('ICO codec', () => {
  it('writes a valid multi-size icon and reads back the largest', async () => {
    const mk = (s: number) => sharp({ create: { width: s, height: s, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 1 } } }).png().toBuffer();
    const ico = encodeIco([
      { size: 16, png: await mk(16) },
      { size: 64, png: await mk(64) },
    ]);
    expect(ico.readUInt16LE(2)).toBe(1); // type: icon
    expect(ico.readUInt16LE(4)).toBe(2); // two images
    expect(icoLargestSize(ico)).toEqual({ width: 64, height: 64 });
    const largest = decodeIcoLargest(ico);
    expect(largest.kind).toBe('png');
  });
  it('encodes a 256px image using the 0 size marker', async () => {
    const png = await sharp({ create: { width: 256, height: 256, channels: 4, background: '#00f' } }).png().toBuffer();
    const ico = encodeIco([{ size: 256, png }]);
    expect(ico[6]).toBe(0);
    expect(icoLargestSize(ico)).toEqual({ width: 256, height: 256 });
  });
  it('rejects garbage', () => {
    expect(() => icoLargestSize(Buffer.from('nope'))).toThrow();
    expect(() => decodeIcoLargest(Buffer.alloc(6))).toThrow();
  });
});
