import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createHarness, makeTempDir } from '../helpers/env';
import { fakeToolchain, EVERYTHING, NOTHING } from '../helpers/toolchain';
import { buildGradientImage, writeFile } from '../helpers/fixtures';
import type { Executor } from '../../src/core/executor';
import type { JobSnapshot } from '../../src/shared/types';

const workDirsLeft = async () => (await fs.readdir(os.tmpdir())).filter((n) => /^morph-[A-Za-z0-9]{6}$/.test(n));

async function png(dir: string, name = 'a.png') {
  return writeFile(path.join(dir, name), await buildGradientImage(32, 32, 'png'));
}

/** Executor that writes a file then waits until released or aborted. */
function controllable() {
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => (release = r));
  const executor: Executor = async (req, _onEvent, signal) => {
    await new Promise<void>((resolve, reject) => {
      void gate.then(resolve);
      signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    });
    const out = path.join(req.workDir, 'o.png');
    await fs.writeFile(out, 'data');
    return { files: [{ path: out, name: 'o.png' }], packaging: 'single' };
  };
  return { executor, release };
}

describe('job lifecycle', () => {
  it('succeeds, publishes next to the source and cleans its work directory', async () => {
    const before = await workDirsLeft();
    const dir = await makeTempDir('jobs');
    const h = await createHarness({ toolchain: NOTHING });
    const job = await h.convert(await png(dir), 'jpg');
    expect(job.status).toBe('succeeded');
    expect(job.primaryOutput).toBe(path.join(dir, 'a.jpg'));
    expect((await fs.readdir(dir)).sort()).toEqual(['a.jpg', 'a.png']);
    expect(await workDirsLeft()).toEqual(before);
  });

  it('never overwrites: repeated conversions get (1), (2)', async () => {
    const dir = await makeTempDir('jobs');
    const h = await createHarness({ toolchain: NOTHING });
    const src = await png(dir);
    const a = await h.convert(src, 'jpg');
    const b = await h.convert(src, 'jpg');
    const c = await h.convert(src, 'jpg');
    expect([a, b, c].map((j) => path.basename(j.primaryOutput ?? ''))).toEqual(['a.jpg', 'a (1).jpg', 'a (2).jpg']);
  });

  it('batch jobs targeting the same name concurrently stay collision-free', async () => {
    const dir = await makeTempDir('jobs');
    const other = await makeTempDir('jobs2');
    const h = await createHarness({ toolchain: NOTHING, concurrency: 4 });
    const files = [await png(dir, 'x.png'), await png(other, 'x.png')];
    const out = await makeTempDir('shared');
    const h2 = await createHarness({ toolchain: NOTHING, concurrency: 4, output: { directory: out } });
    for (const f of files) {
      const file = await h2.inspect(f);
      h2.manager.enqueue(file.id, 'webp', {});
    }
    await h2.manager.idle();
    expect((await fs.readdir(out)).sort()).toEqual(['x (1).webp', 'x.webp']);
    expect(h.manager.list()).toHaveLength(0);
  });

  it('rejects requests for unknown files, unsupported targets and missing tools', async () => {
    const dir = await makeTempDir('jobs');
    const h = await createHarness({ toolchain: NOTHING });
    expect(() => h.manager.enqueue('nope', 'png', {})).toThrowError(/no longer available/);
    const file = await h.inspect(await png(dir));
    expect(() => h.manager.enqueue(file.id, 'mp4', {})).toThrowError(/not supported/);
    expect(() => h.manager.enqueue(file.id, 'jpg', { quality: 'high' })).toThrow();
  });

  it('fails cleanly when the source changes after it was added', async () => {
    const dir = await makeTempDir('jobs');
    const h = await createHarness({ toolchain: NOTHING });
    const src = await png(dir);
    const file = await h.inspect(src);
    await fs.appendFile(src, 'tail');
    h.manager.enqueue(file.id, 'jpg', {});
    await h.manager.idle();
    const job = h.manager.list()[0] as JobSnapshot;
    expect(job.status).toBe('failed');
    expect(job.error?.code).toBe('SOURCE_CHANGED');
    expect(await fs.readdir(dir)).toEqual(['a.png']);
  });

  it('cancels a running job, leaves no output and cleans up', async () => {
    const before = await workDirsLeft();
    const dir = await makeTempDir('jobs');
    const { executor } = controllable();
    const h = await createHarness({ toolchain: NOTHING, executor });
    const file = await h.inspect(await png(dir));
    const job = h.manager.enqueue(file.id, 'jpg', {});
    await new Promise((r) => setTimeout(r, 100));
    expect(h.manager.get(job.id)?.status).toBe('running');
    h.manager.cancel(job.id);
    await h.manager.idle();
    expect(h.manager.get(job.id)).toMatchObject({ status: 'cancelled', outputs: [] });
    expect(await fs.readdir(dir)).toEqual(['a.png']);
    expect(await workDirsLeft()).toEqual(before);
  });

  it('cancels queued jobs without running them, and respects the concurrency limit', async () => {
    const dir = await makeTempDir('jobs');
    let active = 0;
    let peak = 0;
    const executor: Executor = async (req) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 80));
      active -= 1;
      const out = path.join(req.workDir, 'o.png');
      await fs.writeFile(out, 'd');
      return { files: [{ path: out, name: 'o.png' }], packaging: 'single' };
    };
    const h = await createHarness({ toolchain: NOTHING, executor, concurrency: 2 });
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const f = await h.inspect(await png(dir, `f${i}.png`));
      ids.push(h.manager.enqueue(f.id, 'jpg', {}).id);
    }
    h.manager.cancel(ids[4] as string);
    await h.manager.idle();
    expect(peak).toBeLessThanOrEqual(2);
    expect(h.manager.get(ids[4] as string)?.status).toBe('cancelled');
    expect(ids.slice(0, 4).every((id) => h.manager.get(id)?.status === 'succeeded')).toBe(true);
  });

  it('reports engine failures as failed jobs and still cleans up', async () => {
    const before = await workDirsLeft();
    const dir = await makeTempDir('jobs');
    const executor: Executor = async () => {
      throw new Error('boom');
    };
    const h = await createHarness({ toolchain: NOTHING, executor });
    const job = await h.convert(await png(dir), 'jpg');
    expect(job.status).toBe('failed');
    expect(job.error).toBeTruthy();
    expect(await workDirsLeft()).toEqual(before);
    expect(await fs.readdir(dir)).toEqual(['a.png']);
  });

  it('emits throttled updates ending in a terminal state', async () => {
    const dir = await makeTempDir('jobs');
    const h = await createHarness({ toolchain: NOTHING });
    const seen: string[] = [];
    h.manager.on('updated', (s) => seen.push(s.status));
    await h.convert(await png(dir), 'jpg');
    expect(seen[0]).toBe('queued');
    expect(seen.at(-1)).toBe('succeeded');
  });

  it('unused toolchains do not affect image jobs', () => {
    expect(fakeToolchain([]).tools.ffmpeg.found).toBe(false);
    expect(EVERYTHING.tools.ffmpeg.found).toBe(true);
  });
});
