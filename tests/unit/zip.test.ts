import { promises as fs } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createZip } from '../../src/core/zip';
import { makeTempDir } from '../helpers/env';
import { readZip } from '../helpers/zipread';

describe('ZIP creation', () => {
  it('keeps the given order and never lets an entry name escape the archive root', async () => {
    const dir = await makeTempDir('zip');
    const make = async (n: string, c: string) => {
      const p = path.join(dir, n);
      await fs.writeFile(p, c);
      return p;
    };
    const a = await make('a.bin', 'AAAA');
    const b = await make('b.bin', 'BBBB');
    const c = await make('c.bin', 'CCCC');
    const dest = path.join(dir, 'out.zip');
    const names = await createZip(
      [
        { path: a, name: '../../evil.txt' },
        { path: b, name: 'C:\\Windows\\System32\\drop.dll' },
        { path: c, name: '/etc/cron.d/job' },
      ],
      dest,
    );
    expect(names).toEqual(['evil.txt', 'drop.dll', 'job']);
    const listing = await readZip(dest);
    expect(listing.names).toEqual(['evil.txt', 'drop.dll', 'job']);
    for (const n of listing.names) {
      expect(n).not.toMatch(/[\\/]/);
      expect(n).not.toContain('..');
    }
  });

  it('disambiguates duplicate names deterministically (case-insensitive)', async () => {
    const dir = await makeTempDir('zip');
    const p = path.join(dir, 'x');
    await fs.writeFile(p, 'x');
    const dest = path.join(dir, 'o.zip');
    const names = await createZip(
      [
        { path: p, name: 'page.jpg' },
        { path: p, name: 'PAGE.jpg' },
        { path: p, name: 'page.jpg' },
      ],
      dest,
    );
    expect(names).toEqual(['page.jpg', 'PAGE (1).jpg', 'page (2).jpg']);
  });

  it('refuses to overwrite an existing destination', async () => {
    const dir = await makeTempDir('zip');
    const p = path.join(dir, 'x');
    await fs.writeFile(p, 'x');
    const dest = path.join(dir, 'o.zip');
    await fs.writeFile(dest, 'existing');
    await expect(createZip([{ path: p, name: 'x' }], dest)).rejects.toThrow();
    expect(await fs.readFile(dest, 'utf8')).toBe('existing');
  });

  it('streams large files instead of loading them into memory', async () => {
    const dir = await makeTempDir('zip');
    const big = path.join(dir, 'big.bin');
    const handle = await fs.open(big, 'w');
    await handle.truncate(400 * 1024 * 1024); // 400 MB (sparse where supported)
    await handle.close();
    const before = process.memoryUsage().rss;
    const dest = path.join(dir, 'big.zip');
    await createZip([{ path: big, name: 'big.bin' }], dest);
    const growth = process.memoryUsage().rss - before;
    expect(growth).toBeLessThan(150 * 1024 * 1024);
    expect((await fs.stat(dest)).size).toBeGreaterThan(400 * 1024 * 1024);
    const listing = await readZip(dest);
    expect(listing.sizes[0]).toBe(400 * 1024 * 1024);
  }, 120_000);
});
