import { promises as fs } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { locateTool, parseVersion, requireToolPath } from '../../src/core/tools';
import { makeTempDir } from '../helpers/env';
import { NOTHING, EVERYTHING } from '../helpers/toolchain';

async function fakeExe(dir: string, name: string): Promise<string> {
  await fs.mkdir(dir, { recursive: true });
  const p = path.join(dir, name);
  await fs.writeFile(p, '#!/bin/sh\n', { mode: 0o755 });
  return p;
}

describe('tool locator', () => {
  it('prefers a user override, then bundled, then npm, then PATH', async () => {
    const root = await makeTempDir('tools');
    const override = await fakeExe(path.join(root, 'o'), 'ffmpeg');
    const bundled = await fakeExe(path.join(root, 'b', 'ffmpeg'), 'ffmpeg');
    const npm = await fakeExe(path.join(root, 'n'), 'ffmpeg');
    const onPath = await fakeExe(path.join(root, 'p'), 'ffmpeg');
    const env = { PATH: path.dirname(onPath) };
    const opts = { bundledRoots: [path.join(root, 'b')], npmResolvers: { ffmpeg: () => npm }, env, platform: 'linux' as const };

    expect(await locateTool('ffmpeg', { ...opts, overrides: { ffmpeg: override } })).toEqual({ path: override, source: 'settings' });
    expect(await locateTool('ffmpeg', opts)).toEqual({ path: bundled, source: 'bundled' });
    expect(await locateTool('ffmpeg', { ...opts, bundledRoots: [] })).toEqual({ path: npm, source: 'npm' });
    expect(await locateTool('ffmpeg', { env, platform: 'linux' })).toEqual({ path: onPath, source: 'system-path' });
  });

  it('ignores overrides that do not exist or are not executable files', async () => {
    const root = await makeTempDir('tools');
    const notExe = path.join(root, 'plain');
    await fs.writeFile(notExe, 'x', { mode: 0o644 });
    const found = await locateTool('ffmpeg', { overrides: { ffmpeg: notExe }, env: { PATH: '' }, platform: 'linux' });
    expect(found).toBeNull();
    expect(await locateTool('ffmpeg', { overrides: { ffmpeg: path.join(root, 'missing') }, env: { PATH: '' }, platform: 'linux' })).toBeNull();
    expect(await locateTool('ffmpeg', { overrides: { ffmpeg: root }, env: { PATH: '' }, platform: 'linux' })).toBeNull();
  });

  it('finds Poppler nested several folders deep in a bundled directory', async () => {
    const root = await makeTempDir('tools');
    const deep = await fakeExe(path.join(root, 'poppler', 'poppler-24.08.0', 'Library', 'bin'), 'pdftoppm');
    const found = await locateTool('pdftoppm', { bundledRoots: [root], env: { PATH: '' }, platform: 'linux' });
    expect(found?.path).toBe(deep);
  });

  it('returns null when nothing is installed', async () => {
    expect(await locateTool('ffmpeg', { env: { PATH: '' }, platform: 'linux' })).toBeNull();
  });

  it('requireToolPath reports TOOL_MISSING with an install hint', () => {
    expect(() => requireToolPath(NOTHING, 'soffice', 'document conversion')).toThrowError(expect.objectContaining({ code: 'TOOL_MISSING' }));
    expect(requireToolPath(EVERYTHING, 'ffmpeg', 'x')).toBe('/fake/ffmpeg');
  });

  it('parses version strings', () => {
    expect(parseVersion('ffmpeg', 'ffmpeg version 7.0.2-static https://johnvansickle.com\nbuilt with gcc')).toBe('7.0.2-static');
    expect(parseVersion('soffice', 'LibreOffice 24.2.7.2 420(Build:2)')).toBe('24.2.7.2');
    expect(parseVersion('pdftoppm', 'pdftoppm version 24.08.0\nCopyright')).toBe('24.08.0');
    expect(parseVersion('ffmpeg', '')).toBeUndefined();
  });
});
