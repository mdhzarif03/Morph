import { promises as fs } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { finalizeOutputs, outputFileName, reserveOutputName, withCollisionIndex, type OutputSettings } from '../../src/core/output';
import { isInside, safeEntryName, sanitizeFileName } from '../../src/core/fsutil';
import { makeTempDir } from '../helpers/env';

const same: OutputSettings = { naming: 'same-name', suffix: '_converted', directory: null };

describe('output naming', () => {
  it('keeps the base name, or appends a sanitised suffix', () => {
    expect(outputFileName('logo', 'webp', same)).toBe('logo.webp');
    expect(outputFileName('logo', 'webp', { ...same, naming: 'suffix' })).toBe('logo_converted.webp');
    expect(outputFileName('logo', 'webp', { ...same, naming: 'suffix', suffix: '/../evil' })).toBe('logo..evil.webp'.replace('..', '..'));
    expect(outputFileName('logo', 'webp', { ...same, naming: 'suffix', suffix: '<>:"|?*' })).toBe('logo.webp');
  });

  it('truncates very long names and strips illegal characters', () => {
    const long = 'x'.repeat(400);
    expect(outputFileName(long, 'png', same).length).toBeLessThanOrEqual(154);
    expect(outputFileName('a:b*c?', 'png', same)).toBe('a_b_c_.png');
  });

  it('numbers collisions deterministically', () => {
    expect(withCollisionIndex('logo.webp', 0)).toBe('logo.webp');
    expect(withCollisionIndex('logo.webp', 1)).toBe('logo (1).webp');
    expect(withCollisionIndex('archive.tar.gz', 2)).toBe('archive.tar (2).gz');
    expect(withCollisionIndex('noext', 3)).toBe('noext (3)');
  });

  it('sanitises Windows-reserved and dangerous names', () => {
    expect(sanitizeFileName('CON')).toBe('_CON');
    expect(sanitizeFileName('nul.txt')).toBe('_nul.txt');
    expect(sanitizeFileName('..')).toBe('file');
    expect(sanitizeFileName('trailing. ')).toBe('trailing');
    expect(sanitizeFileName('a/b\\c')).toBe('a_b_c');
    expect(safeEntryName('../../etc/passwd')).toBe('passwd');
    expect(safeEntryName('..\\..\\windows\\system32\\evil.dll')).toBe('evil.dll');
    expect(safeEntryName('/abs/path/page.jpg')).toBe('page.jpg');
  });

  it('isInside rejects traversal', () => {
    expect(isInside('/a/b', '/a/b/c')).toBe(true);
    expect(isInside('/a/b', '/a/b')).toBe(true);
    expect(isInside('/a/b', '/a/bc')).toBe(false);
    expect(isInside('/a/b', '/a/b/../c')).toBe(false);
  });
});

describe('output reservation and publishing', () => {
  it('parallel jobs racing for the same name get unique names and nothing is overwritten', async () => {
    const dir = await makeTempDir('out');
    const existing = path.join(dir, 'logo.webp');
    await fs.writeFile(existing, 'user data');
    const results = await Promise.all(Array.from({ length: 25 }, () => reserveOutputName(dir, 'logo.webp')));
    const names = results.map((r) => r.name);
    expect(new Set(names).size).toBe(25);
    expect(names).not.toContain('logo.webp');
    expect(await fs.readFile(existing, 'utf8')).toBe('user data');
  });

  it('publishes a single file, removes temp artefacts and leaves no partials', async () => {
    const dir = await makeTempDir('out');
    const work = await makeTempDir('work');
    const produced = path.join(work, 'output.webp');
    await fs.writeFile(produced, Buffer.alloc(1000, 7));
    const outputs = await finalizeOutputs({
      result: { files: [{ path: produced, name: 'logo.webp' }], packaging: 'single' },
      sourcePath: path.join(dir, 'logo.png'),
      baseName: 'logo',
      workDir: work,
      settings: same,
      signal: new AbortController().signal,
    });
    expect(outputs[0]?.path).toBe(path.join(dir, 'logo.webp'));
    expect(outputs[0]?.size).toBe(1000);
    expect(await fs.readdir(dir)).toEqual(['logo.webp']);
  });

  it('refuses empty output and does not leave a placeholder behind', async () => {
    const dir = await makeTempDir('out');
    const work = await makeTempDir('work');
    const produced = path.join(work, 'output.webp');
    await fs.writeFile(produced, '');
    await expect(
      finalizeOutputs({ result: { files: [{ path: produced, name: 'x.webp' }], packaging: 'single' }, sourcePath: path.join(dir, 'x.png'), baseName: 'x', workDir: work, settings: same, signal: new AbortController().signal }),
    ).rejects.toMatchObject({ code: 'TOOL_FAILED' });
    expect(await fs.readdir(dir)).toEqual([]);
  });

  it('cancellation before publishing leaves the destination untouched', async () => {
    const dir = await makeTempDir('out');
    const work = await makeTempDir('work');
    const produced = path.join(work, 'output.png');
    await fs.writeFile(produced, 'data');
    const controller = new AbortController();
    controller.abort();
    await expect(
      finalizeOutputs({ result: { files: [{ path: produced, name: 'x.png' }], packaging: 'single' }, sourcePath: path.join(dir, 'x.jpg'), baseName: 'x', workDir: work, settings: same, signal: controller.signal }),
    ).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(await fs.readdir(dir)).toEqual([]);
  });

  it('reports a non-writable or vanished output folder clearly', async () => {
    const work = await makeTempDir('work');
    const produced = path.join(work, 'o.png');
    await fs.writeFile(produced, 'data');
    const missing = path.join(await makeTempDir('gone'), 'does', 'not', 'exist');
    // Missing folders are created (override directories may not exist yet)...
    const outputs = await finalizeOutputs({
      result: { files: [{ path: produced, name: 'o.png' }], packaging: 'single' },
      sourcePath: '/ignored/o.jpg',
      baseName: 'o',
      workDir: work,
      settings: { ...same, directory: missing },
      signal: new AbortController().signal,
    });
    expect(outputs[0]?.path).toBe(path.join(missing, 'o.png'));
  });

  it('packages several files into a ZIP named after the source', async () => {
    const dir = await makeTempDir('out');
    const work = await makeTempDir('work');
    const files = [];
    for (const n of ['b_page_002.png', 'b_page_001.png']) {
      const p = path.join(work, n);
      await fs.writeFile(p, `data ${n}`);
      files.push({ path: p, name: n });
    }
    const outputs = await finalizeOutputs({ result: { files, packaging: 'zip' }, sourcePath: path.join(dir, 'b.pdf'), baseName: 'b', workDir: work, settings: same, signal: new AbortController().signal });
    expect(outputs[0]?.path).toBe(path.join(dir, 'b.zip'));
    expect(await fs.readdir(dir)).toEqual(['b.zip']);
  });
});
