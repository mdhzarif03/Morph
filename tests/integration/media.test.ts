import { promises as fs } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildWav, writeFile } from '../helpers/fixtures';
import { createHarness, getToolchain, hasTool, makeTempDir } from '../helpers/env';
import { probeMedia } from '../../src/core/engines/media';
import { runProcess } from '../../src/core/proc';

const ffmpegAvailable = (await hasTool('ffmpeg')) && (await hasTool('ffprobe'));
const tc = await getToolchain();
const ffmpeg = tc.tools.ffmpeg.path ?? '';
const ffprobe = tc.tools.ffprobe.path ?? '';

/** Creates a tiny real test video (testsrc + sine) with the real ffmpeg. */
async function makeVideo(file: string, args: string[] = ['-c:v', 'libx264', '-c:a', 'aac'], opts: { size?: string; seconds?: number } = {}): Promise<void> {
  const { size = '320x240', seconds = 2 } = opts;
  const r = await runProcess(ffmpeg, ['-y', '-f', 'lavfi', '-i', `testsrc=size=${size}:rate=15:duration=${seconds}`, '-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`, '-pix_fmt', 'yuv420p', ...args, '-shortest', file]);
  if (r.code !== 0) throw new Error(`fixture failed: ${r.stderr}`);
}

const probe = (file: string) => probeMedia(ffprobe, file);

async function videoPacketSizes(file: string): Promise<string[]> {
  const r = await runProcess(ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'packet=size', '-of', 'csv=p=0', file]);
  return r.stdout.split(/\r?\n/).filter(Boolean);
}

describe.skipIf(!ffmpegAvailable)('audio conversion (FFmpeg)', () => {
  it.each([
    ['mp3', 'mp3'],
    ['flac', 'flac'],
    ['aac', 'aac'],
    ['ogg', 'vorbis'],
    ['m4a', 'aac'],
  ] as const)('WAV -> %s decodes with codec %s and keeps the duration', async (target, codec) => {
    const dir = await makeTempDir('aud');
    const source = await writeFile(path.join(dir, 'tone.wav'), buildWav(2));
    const h = await createHarness();
    const job = await h.convert(source, target);
    expect(job.status, JSON.stringify(job.error)).toBe('succeeded');
    expect(job.outputs[0]?.name).toBe(`tone.${target}`);
    const info = await probe(job.outputs[0]?.path ?? '');
    expect(info.audioStreams[0]?.codec).toBe(codec);
    expect(info.durationSec ?? 0).toBeGreaterThan(1.7);
    expect(info.durationSec ?? 0).toBeLessThan(2.4);
  });

  it('FLAC -> WAV produces 24-bit PCM when asked', async () => {
    const dir = await makeTempDir('aud');
    const wav = await writeFile(path.join(dir, 'tone.wav'), buildWav(1));
    const h = await createHarness();
    const flac = await h.convert(wav, 'flac');
    const job = await h.convert(flac.outputs[0]?.path ?? '', 'wav', { bitDepth: '24' });
    expect(job.status, JSON.stringify(job.error)).toBe('succeeded');
    expect((await probe(job.outputs[0]?.path ?? '')).audioStreams[0]?.codec).toBe('pcm_s24le');
  });

  it('applies bitrate and sample-rate options', async () => {
    const dir = await makeTempDir('aud');
    const source = await writeFile(path.join(dir, 'tone.wav'), buildWav(2, 44100));
    const h = await createHarness();
    const small = await h.convert(source, 'mp3', { bitrate: '64' });
    const big = await h.convert(source, 'mp3', { bitrate: '320', sampleRate: '48000' });
    expect((await fs.stat(big.outputs[0]?.path ?? '')).size).toBeGreaterThan((await fs.stat(small.outputs[0]?.path ?? '')).size * 2);
    const r = await runProcess(ffprobe, ['-v', 'error', '-show_entries', 'stream=sample_rate', '-of', 'csv=p=0', big.outputs[0]?.path ?? '']);
    expect(r.stdout.trim()).toBe('48000');
  });

  it('extracts the audio track from a video', async () => {
    const dir = await makeTempDir('aud');
    const video = path.join(dir, 'clip.mp4');
    await makeVideo(video);
    const h = await createHarness();
    const inspected = await h.inspect(video);
    expect(inspected.details.hasVideo).toBe(true);
    expect(inspected.targets.map((t) => t.format)).toContain('mp3');
    const job = await h.convert(video, 'mp3');
    expect(job.status, JSON.stringify(job.error)).toBe('succeeded');
    const info = await probe(job.outputs[0]?.path ?? '');
    expect(info.videoStreams).toHaveLength(0);
    expect(info.audioStreams[0]?.codec).toBe('mp3');
  });

  it('refuses audio-to-video and reports a video without audio', async () => {
    const dir = await makeTempDir('aud');
    const source = await writeFile(path.join(dir, 'tone.wav'), buildWav(1));
    const h = await createHarness();
    const file = await h.inspect(source);
    expect(file.targets.map((t) => t.format)).not.toContain('mp4');
    expect(() => h.manager.enqueue(file.id, 'mp4', {})).toThrowError(/not supported/);

    const silent = path.join(dir, 'silent.mp4');
    const r = await runProcess(ffmpeg, ['-y', '-f', 'lavfi', '-i', 'testsrc=size=160x120:rate=10:duration=1', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', silent]);
    expect(r.code).toBe(0);
    const job = await h.convert(silent, 'mp3');
    expect(job.status).toBe('failed');
    expect(job.error?.message).toMatch(/no audio track/);
  });
});

describe.skipIf(!ffmpegAvailable)('video conversion (FFmpeg)', () => {
  it('MP4 -> MKV is a lossless stream copy (no re-encoding)', async () => {
    const dir = await makeTempDir('vid');
    const source = path.join(dir, 'movie.mp4');
    await makeVideo(source);
    const h = await createHarness();
    const job = await h.convert(source, 'mkv');
    expect(job.status, JSON.stringify(job.error)).toBe('succeeded');
    const info = await probe(job.outputs[0]?.path ?? '');
    expect(info.videoStreams[0]?.codec).toBe('h264');
    expect(info.audioStreams[0]?.codec).toBe('aac');
    // A real stream copy keeps the compressed video packets byte-for-byte: identical packet sizes.
    expect(await videoPacketSizes(job.outputs[0]?.path ?? '')).toEqual(await videoPacketSizes(source));
  });

  it('re-encodes (different packets) when "always re-encode" is chosen', async () => {
    const dir = await makeTempDir('vid');
    const source = path.join(dir, 'movie.mp4');
    await makeVideo(source);
    const h = await createHarness();
    const job = await h.convert(source, 'mkv', { mode: 'reencode' });
    expect(job.status, JSON.stringify(job.error)).toBe('succeeded');
    expect(await videoPacketSizes(job.outputs[0]?.path ?? '')).not.toEqual(await videoPacketSizes(source));
  }, 120_000);

  it('copies compatible streams but re-encodes when the container cannot hold them', async () => {
    const dir = await makeTempDir('vid');
    const source = path.join(dir, 'movie.mp4');
    await makeVideo(source);
    const h = await createHarness();
    const webm = await h.convert(source, 'webm', { quality: 'small' });
    expect(webm.status, JSON.stringify(webm.error)).toBe('succeeded');
    const info = await probe(webm.outputs[0]?.path ?? '');
    expect(info.videoStreams[0]?.codec).toBe('vp9');
    expect(['opus', 'vorbis']).toContain(info.audioStreams[0]?.codec);
  }, 120_000);

  it('scales down to the chosen resolution and never enlarges', async () => {
    const dir = await makeTempDir('vid');
    const big = path.join(dir, 'big.mp4');
    await makeVideo(big, undefined, { size: '640x480' });
    const h = await createHarness();
    const job = await h.convert(big, 'mov', { maxHeight: '360' });
    expect(job.status, JSON.stringify(job.error)).toBe('succeeded');
    const info = await probe(job.outputs[0]?.path ?? '');
    expect(info.videoStreams[0]?.height).toBe(360);
    expect(info.videoStreams[0]?.width).toBe(480); // aspect ratio preserved

    const small = path.join(dir, 'small.mp4');
    await makeVideo(small); // 320x240
    const kept = await h.convert(small, 'mov', { maxHeight: '360' });
    expect((await probe(kept.outputs[0]?.path ?? '')).videoStreams[0]?.height).toBe(240);
    expect(kept.warnings.join(' ')).toMatch(/already at or below/);
  }, 120_000);

  it('reports intermediate progress while encoding', async () => {
    const dir = await makeTempDir('vid');
    const source = path.join(dir, 'long.mp4');
    await makeVideo(source, undefined, { size: '640x480', seconds: 30 });
    const h = await createHarness();
    const file = await h.inspect(source);
    const seen: number[] = [];
    h.manager.on('updated', (s) => {
      if (typeof s.progress === 'number') seen.push(s.progress);
    });
    h.manager.enqueue(file.id, 'avi', { mode: 'reencode' });
    await h.manager.idle();
    expect(seen.at(-1)).toBe(1);
    expect(seen.filter((p) => p > 0 && p < 1).length).toBeGreaterThanOrEqual(2);
    expect([...seen].sort((a, b) => a - b)).toEqual(seen); // monotonic
  }, 180_000);

  it('rejects a non-media file renamed to .mp4 by its content', async () => {
    const dir = await makeTempDir('vid');
    const fake = await writeFile(path.join(dir, 'fake.mp4'), 'this is just text pretending to be a video, '.repeat(20));
    const h = await createHarness();
    await expect(h.inspect(fake)).rejects.toMatchObject({ code: 'UNSUPPORTED_FORMAT' });
  });
});
