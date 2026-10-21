import { describe, expect, it } from 'vitest';
import { audioOptionSpecs, buildAudioPlan, buildVideoPlan, parseFfprobe, videoOptionSpecs, type MediaInfo } from '../../src/core/engines/media';
import { defaultOptions } from '../../src/shared/options';
import { ALL_ENCODERS, EVERYTHING } from '../helpers/toolchain';

const info = (over: Partial<MediaInfo> & { vcodec?: string; acodec?: string; height?: number } = {}): MediaInfo => {
  const video = { index: 0, type: 'video' as const, codec: over.vcodec ?? 'h264', width: 1920, height: over.height ?? 1080, attachedPicture: false };
  const audio = { index: 1, type: 'audio' as const, codec: over.acodec ?? 'aac', attachedPicture: false };
  return { durationSec: 10, streams: [video, audio], videoStreams: [video], audioStreams: [audio], subtitleCount: 0, ...over };
};
const vopts = (target: Parameters<typeof videoOptionSpecs>[0], extra: Record<string, string | number | boolean> = {}) => ({ ...defaultOptions(videoOptionSpecs(target, EVERYTHING)), ...extra });
const aopts = (target: Parameters<typeof audioOptionSpecs>[0], extra: Record<string, string | number | boolean> = {}) => ({ ...defaultOptions(audioOptionSpecs(target)), ...extra });
const pairs = (args: string[], flag: string) => args.flatMap((a, i) => (a === flag ? [args[i + 1]] : []));

describe('ffprobe parsing', () => {
  it('separates streams and ignores cover art as video', () => {
    const json = JSON.stringify({
      format: { duration: '12.5' },
      streams: [
        { index: 0, codec_type: 'audio', codec_name: 'mp3' },
        { index: 1, codec_type: 'video', codec_name: 'mjpeg', width: 500, height: 500, disposition: { attached_pic: 1 } },
        { index: 2, codec_type: 'subtitle', codec_name: 'subrip' },
      ],
    });
    const parsed = parseFfprobe(json);
    expect(parsed.durationSec).toBe(12.5);
    expect(parsed.audioStreams).toHaveLength(1);
    expect(parsed.videoStreams).toHaveLength(0);
    expect(parsed.subtitleCount).toBe(1);
  });
  it('rejects non-JSON as corrupt input', () => {
    expect(() => parseFfprobe('not json')).toThrowError(expect.objectContaining({ code: 'CORRUPT_INPUT' }));
  });
});

describe('video plans', () => {
  it('stream-copies when the source already fits the container', () => {
    const plan = buildVideoPlan('/in.mkv', '/out.mp4', 'mp4', vopts('mp4'), info(), ALL_ENCODERS);
    expect(plan.summary).toBe('video: copy, audio: copy');
    expect(pairs(plan.args, '-c:v')).toEqual(['copy']);
    expect(plan.args).not.toContain('-crf');
  });

  it('re-encodes when the codec cannot live in the container (VP9 -> MP4 H.264)', () => {
    const plan = buildVideoPlan('/in.webm', '/out.mp4', 'mp4', vopts('mp4'), info({ vcodec: 'vp9', acodec: 'opus' }), ALL_ENCODERS);
    expect(pairs(plan.args, '-c:v')).toEqual(['libx264']);
    expect(pairs(plan.args, '-c:a')).toEqual(['aac']);
  });

  it('forces re-encoding in "reencode" mode and when downscaling', () => {
    const forced = buildVideoPlan('/in.mp4', '/out.mp4', 'mp4', vopts('mp4', { mode: 'reencode' }), info(), ALL_ENCODERS);
    expect(pairs(forced.args, '-c:v')).not.toContain('copy');
    const scaled = buildVideoPlan('/in.mp4', '/out.mp4', 'mp4', vopts('mp4', { maxHeight: '720' }), info(), ALL_ENCODERS);
    expect(pairs(scaled.args, '-c:v')).not.toContain('copy');
    expect(pairs(scaled.args, '-vf')[0]).toContain('scale=-2:720');
  });

  it('never upscales and tells the user', () => {
    const plan = buildVideoPlan('/in.mp4', '/out.mp4', 'mp4', vopts('mp4', { maxHeight: '1080' }), info({ height: 480 }), ALL_ENCODERS);
    expect(plan.warnings.join(' ')).toMatch(/not scaled/);
    expect(pairs(plan.args, '-vf').join()).not.toContain('scale=-2');
  });

  it('keeps even dimensions and a compatible pixel format when encoding', () => {
    const plan = buildVideoPlan('/in.mp4', '/out.mp4', 'mp4', vopts('mp4', { mode: 'reencode' }), info(), ALL_ENCODERS);
    expect(pairs(plan.args, '-vf')[0]).toContain('trunc(iw/2)*2');
    expect(pairs(plan.args, '-pix_fmt')).toEqual(['yuv420p']);
  });

  it('fails clearly when the FFmpeg build lacks the needed encoder', () => {
    expect(() => buildVideoPlan('/in.webm', '/out.mp4', 'mp4', vopts('mp4'), info({ vcodec: 'vp9', acodec: 'opus' }), ['aac'])).toThrowError(expect.objectContaining({ code: 'ENCODER_MISSING' }));
  });

  it('maps only the first video stream, drops subtitles, and warns', () => {
    const plan = buildVideoPlan('/in.mkv', '/out.mp4', 'mp4', vopts('mp4'), info({ subtitleCount: 2 }), ALL_ENCODERS);
    expect(plan.args.join(' ')).toContain('-map 0:0 -map 0:a?');
    expect(plan.args).toContain('-sn');
    expect(plan.warnings.join(' ')).toMatch(/Subtitle/);
  });

  it('handles silent video and rejects audio-only input', () => {
    const silent = info({ audioStreams: [] });
    expect(buildVideoPlan('/i', '/o.mp4', 'mp4', vopts('mp4'), silent, ALL_ENCODERS).args).not.toContain('-b:a');
    const none = info({ videoStreams: [] });
    expect(() => buildVideoPlan('/i', '/o.mp4', 'mp4', vopts('mp4'), none, ALL_ENCODERS)).toThrowError(expect.objectContaining({ code: 'INVALID_INPUT' }));
  });

  it('adds faststart for MP4/MOV and passes paths as separate argv entries', () => {
    const weird = '/tmp/a b; rm -rf ~ "quoted".mkv';
    const plan = buildVideoPlan(weird, '/tmp/o p.mp4', 'mp4', vopts('mp4'), info(), ALL_ENCODERS);
    expect(plan.args).toContain('+faststart');
    expect(plan.args).toContain(weird);
    expect(plan.args.at(-1)).toBe('/tmp/o p.mp4');
  });
});

describe('audio plans', () => {
  it('picks the codec per target and passes bitrate', () => {
    const mp3 = buildAudioPlan('/i', '/o.mp3', 'mp3', aopts('mp3', { bitrate: '256' }), info(), ALL_ENCODERS);
    expect(pairs(mp3.args, '-c:a')).toEqual(['libmp3lame']);
    expect(pairs(mp3.args, '-b:a')).toEqual(['256k']);
    expect(pairs(buildAudioPlan('/i', '/o.flac', 'flac', aopts('flac'), info(), ALL_ENCODERS).args, '-c:a')).toEqual(['flac']);
    expect(pairs(buildAudioPlan('/i', '/o.wav', 'wav', aopts('wav', { bitDepth: '24' }), info(), ALL_ENCODERS).args, '-c:a')).toEqual(['pcm_s24le']);
  });
  it('drops video, keeps metadata and falls back to Opus when Vorbis is missing', () => {
    const plan = buildAudioPlan('/i', '/o.ogg', 'ogg', aopts('ogg'), info(), ['libopus']);
    expect(plan.args).toContain('-vn');
    expect(plan.args).toContain('-map_metadata');
    expect(pairs(plan.args, '-c:a')).toEqual(['libopus']);
  });
  it('warns about extra tracks and rejects files with no audio', () => {
    const a2 = { index: 2, type: 'audio' as const, codec: 'aac', attachedPicture: false };
    const base = info();
    const multi = { ...base, audioStreams: [...base.audioStreams, a2] };
    expect(buildAudioPlan('/i', '/o.mp3', 'mp3', aopts('mp3'), multi, ALL_ENCODERS).warnings.join()).toMatch(/2 audio tracks/);
    expect(() => buildAudioPlan('/i', '/o.mp3', 'mp3', aopts('mp3'), info({ audioStreams: [] }), ALL_ENCODERS)).toThrowError(expect.objectContaining({ code: 'INVALID_INPUT' }));
  });
});
