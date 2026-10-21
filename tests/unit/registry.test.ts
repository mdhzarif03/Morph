import { describe, expect, it } from 'vitest';
import { FORMAT_IDS, FORMATS } from '../../src/shared/formats';
import { allRoutes, describeTargets, findRoute, resolveConversion, targetsFor } from '../../src/core/registry';
import { fakeToolchain, EVERYTHING, NOTHING } from '../helpers/toolchain';

const quality = { jpg: 85, webp: 80, avif: 55 };
const env = (toolchain = EVERYTHING) => ({ toolchain, quality });

describe('conversion registry', () => {
  it('only lists conversions that stay inside one sensible category', () => {
    for (const route of allRoutes()) {
      const s = FORMATS[route.source].category;
      const t = FORMATS[route.target].category;
      const ok =
        (s === 'image' && t === 'image') ||
        (s === 'document' && (t === 'document' || t === 'image')) ||
        (s === 'audio' && t === 'audio') ||
        (s === 'video' && (t === 'video' || t === 'audio'));
      expect(ok, `${route.source}->${route.target}`).toBe(true);
    }
  });

  it('never advertises unsupported paths', () => {
    expect(findRoute('png', 'pdf')).toBeUndefined();
    expect(findRoute('pdf', 'docx')).toBeUndefined(); // PDF -> Word is deliberately not offered
    expect(findRoute('mp3', 'mp4')).toBeUndefined();
    expect(findRoute('wav', 'wav')).toBeUndefined();
    expect(findRoute('docx', 'mp3')).toBeUndefined();
    expect(targetsFor('pdf').sort()).toEqual(['jpg', 'png']);
  });

  it('offers the documented document paths', () => {
    for (const source of ['docx', 'doc', 'odt', 'txt'] as const) {
      expect(targetsFor(source)).toEqual(expect.arrayContaining(['pdf', 'png', 'jpg']));
    }
    expect(targetsFor('docx')).toContain('odt');
    expect(targetsFor('doc')).toContain('docx');
  });

  it('covers every image format as both source and target', () => {
    const images = FORMAT_IDS.filter((f) => FORMATS[f].category === 'image');
    for (const source of images) expect(targetsFor(source).sort()).toEqual([...images].sort());
  });

  it('marks tool-dependent targets unavailable with an install hint when tools are missing', () => {
    const none = describeTargets('docx', env(NOTHING));
    const pdf = none.find((t) => t.format === 'pdf');
    expect(pdf?.available).toBe(false);
    expect(pdf?.unavailableReason).toMatch(/LibreOffice is not installed/);

    const imagesStillWork = describeTargets('png', env(NOTHING));
    expect(imagesStillWork.every((t) => t.available)).toBe(true);
  });

  it('requires every tool of a path: page images need both LibreOffice and Poppler', () => {
    const onlyOffice = describeTargets('docx', env(fakeToolchain(['soffice'])));
    expect(onlyOffice.find((t) => t.format === 'pdf')?.available).toBe(true);
    expect(onlyOffice.find((t) => t.format === 'png')?.available).toBe(false);
  });

  it('disables audio/video targets whose encoder is missing from this FFmpeg build', () => {
    const tc = fakeToolchain(['ffmpeg', 'ffprobe'], ['aac', 'flac', 'pcm_s16le']);
    const targets = describeTargets('wav', env(tc));
    expect(targets.find((t) => t.format === 'mp3')?.available).toBe(false);
    expect(targets.find((t) => t.format === 'mp3')?.unavailableReason).toMatch(/MP3 encoder/);
    expect(targets.find((t) => t.format === 'flac')?.available).toBe(true);
  });

  it('builds option specs per target (quality only where it applies)', () => {
    const png = describeTargets('jpg', env()).find((t) => t.format === 'png');
    const jpg = describeTargets('png', env()).find((t) => t.format === 'jpg');
    expect(png?.options.map((o) => o.key)).not.toContain('quality');
    expect(jpg?.options.map((o) => o.key)).toEqual(expect.arrayContaining(['quality', 'background']));
    expect(jpg?.options.find((o) => o.key === 'quality')).toMatchObject({ default: 85 }); // from settings
  });

  it('resolveConversion rejects unsupported pairs and missing tools with clear codes', () => {
    expect(() => resolveConversion('png', 'mp4', {}, env())).toThrowError(/not supported/);
    expect(() => resolveConversion('docx', 'pdf', {}, env(NOTHING))).toThrowError(/LibreOffice is not installed/);
    try {
      resolveConversion('docx', 'pdf', {}, env(NOTHING));
    } catch (e) {
      expect((e as { code: string }).code).toBe('TOOL_MISSING');
    }
    expect(() => resolveConversion('png', 'jpg', { quality: 500 }, env())).toThrowError(/between 1 and 100/);
    expect(resolveConversion('png', 'jpg', { quality: 70 }, env()).options.quality).toBe(70);
  });
});
