import { promises as fs } from 'node:fs';
import path from 'node:path';
import { MorphError } from '../../shared/errors';
import { FORMATS, outputExtension, type FormatId } from '../../shared/formats';
import { optNumber, optString, type OptionSpec } from '../../shared/options';
import type { FileDetails, ToolchainSnapshot } from '../../shared/types';
import { runProcess, tailLines } from '../proc';
import { requireToolPath, toolPath } from '../tools';
import type { EngineContext, EngineResult } from './types';

export const AUDIO_FORMATS: readonly FormatId[] = ['mp3', 'wav', 'flac', 'aac', 'ogg', 'm4a'];
export const VIDEO_FORMATS: readonly FormatId[] = ['mp4', 'mkv', 'mov', 'webm', 'avi'];

// ---------------------------------------------------------------------------------------------
// Probing

export interface MediaStream {
  index: number;
  type: 'video' | 'audio' | 'subtitle' | 'other';
  codec: string;
  width?: number;
  height?: number;
  attachedPicture: boolean;
}

export interface MediaInfo {
  durationSec: number | null;
  streams: MediaStream[];
  videoStreams: MediaStream[];
  audioStreams: MediaStream[];
  subtitleCount: number;
}

interface FfprobeJson {
  format?: { duration?: string };
  streams?: Array<{
    index: number;
    codec_type?: string;
    codec_name?: string;
    width?: number;
    height?: number;
    disposition?: { attached_pic?: number };
    duration?: string;
  }>;
}

export function parseFfprobe(json: string): MediaInfo {
  let data: FfprobeJson;
  try {
    data = JSON.parse(json) as FfprobeJson;
  } catch {
    throw new MorphError('CORRUPT_INPUT', 'The media file could not be read.');
  }
  const streams: MediaStream[] = (data.streams ?? []).map((s) => {
    const type = s.codec_type === 'video' || s.codec_type === 'audio' || s.codec_type === 'subtitle' ? s.codec_type : 'other';
    const stream: MediaStream = { index: s.index, type, codec: s.codec_name ?? 'unknown', attachedPicture: (s.disposition?.attached_pic ?? 0) === 1 };
    if (s.width) stream.width = s.width;
    if (s.height) stream.height = s.height;
    return stream;
  });
  const duration = Number(data.format?.duration ?? data.streams?.find((s) => s.duration)?.duration);
  return {
    durationSec: Number.isFinite(duration) && duration > 0 ? duration : null,
    streams,
    videoStreams: streams.filter((s) => s.type === 'video' && !s.attachedPicture),
    audioStreams: streams.filter((s) => s.type === 'audio'),
    subtitleCount: streams.filter((s) => s.type === 'subtitle').length,
  };
}

export async function probeMedia(ffprobePath: string, filePath: string, signal?: AbortSignal): Promise<MediaInfo> {
  const result = await runProcess(ffprobePath, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', '--', filePath], {
    timeoutMs: 60_000,
    maxCaptureBytes: 8_000_000,
    ...(signal ? { signal } : {}),
  });
  if (result.code !== 0) {
    throw new MorphError('CORRUPT_INPUT', 'The media file could not be read. It may be damaged or in an unsupported format.', { detail: tailLines(result.stderr) });
  }
  const info = parseFfprobe(result.stdout);
  if (info.audioStreams.length === 0 && info.videoStreams.length === 0) {
    throw new MorphError('CORRUPT_INPUT', 'No audio or video was found in this file.');
  }
  return info;
}

export async function inspectMedia(toolchain: ToolchainSnapshot, filePath: string): Promise<FileDetails> {
  const ffprobe = toolPath(toolchain, 'ffprobe');
  if (!ffprobe) return {};
  const info = await probeMedia(ffprobe, filePath);
  const v = info.videoStreams[0];
  const a = info.audioStreams[0];
  const details: FileDetails = { hasVideo: info.videoStreams.length > 0, hasAudio: info.audioStreams.length > 0 };
  if (info.durationSec !== null) details.durationSec = info.durationSec;
  if (v) {
    details.videoCodec = v.codec;
    if (v.width) details.width = v.width;
    if (v.height) details.height = v.height;
  }
  if (a) details.audioCodec = a.codec;
  return details;
}

// ---------------------------------------------------------------------------------------------
// Encoder selection

function has(encoders: readonly string[], name: string): boolean {
  return encoders.includes(name);
}

export function ffmpegEncoders(toolchain: ToolchainSnapshot): string[] {
  return toolchain.tools.ffmpeg.encoders ?? [];
}

type VideoCodecId = 'h264' | 'h265' | 'vp9' | 'av1' | 'mpeg4';

const VIDEO_CODECS: Record<VideoCodecId, { label: string; encoders: string[]; probeName: string[] }> = {
  h264: { label: 'H.264 (most compatible)', encoders: ['libx264'], probeName: ['h264'] },
  h265: { label: 'H.265 / HEVC (smaller files)', encoders: ['libx265'], probeName: ['hevc'] },
  vp9: { label: 'VP9', encoders: ['libvpx-vp9'], probeName: ['vp9'] },
  av1: { label: 'AV1 (smallest, slow)', encoders: ['libsvtav1', 'libaom-av1'], probeName: ['av1'] },
  mpeg4: { label: 'MPEG-4 Part 2 (legacy)', encoders: ['mpeg4'], probeName: ['mpeg4'] },
};

/** Video codecs each container may carry, best default first. */
const CONTAINER_VIDEO: Record<string, VideoCodecId[]> = {
  mp4: ['h264', 'h265', 'av1'],
  mkv: ['h264', 'h265', 'vp9', 'av1'],
  mov: ['h264', 'h265'],
  webm: ['vp9', 'av1'],
  avi: ['mpeg4', 'h264'],
};

/** Source codecs (ffprobe names) that can be copied into each container without re-encoding. */
const COPYABLE_VIDEO: Record<string, string[]> = {
  mp4: ['h264', 'hevc', 'av1', 'mpeg4'],
  mkv: ['h264', 'hevc', 'vp9', 'vp8', 'av1', 'mpeg4', 'mpeg2video', 'theora'],
  mov: ['h264', 'hevc', 'mpeg4', 'prores', 'mjpeg'],
  webm: ['vp8', 'vp9', 'av1'],
  avi: ['mpeg4', 'h264', 'mjpeg'],
};
const COPYABLE_AUDIO: Record<string, string[]> = {
  mp4: ['aac', 'mp3', 'ac3', 'eac3', 'alac'],
  mkv: ['aac', 'mp3', 'ac3', 'eac3', 'opus', 'vorbis', 'flac', 'dts', 'pcm_s16le', 'pcm_s24le'],
  mov: ['aac', 'mp3', 'ac3', 'alac', 'pcm_s16le', 'pcm_s24le'],
  webm: ['opus', 'vorbis'],
  avi: ['mp3', 'ac3', 'pcm_s16le'],
};

function pickVideoEncoder(codec: VideoCodecId, encoders: readonly string[]): string | null {
  return VIDEO_CODECS[codec].encoders.find((e) => has(encoders, e)) ?? null;
}

function availableVideoCodecs(container: string, encoders: readonly string[]): VideoCodecId[] {
  return (CONTAINER_VIDEO[container] ?? []).filter((c) => pickVideoEncoder(c, encoders) !== null);
}

/** Audio encoder to use inside a given video container, or null when none is available. */
function pickContainerAudioEncoder(container: string, encoders: readonly string[]): { encoder: string; bitrate: string } | null {
  const prefer: Array<[string, string]> =
    container === 'webm'
      ? [['libopus', '128k'], ['libvorbis', '128k']]
      : container === 'avi'
        ? [['libmp3lame', '192k'], ['ac3', '192k']]
        : [['aac', '192k'], ['libmp3lame', '192k']];
  const hit = prefer.find(([e]) => has(encoders, e));
  return hit ? { encoder: hit[0], bitrate: hit[1] } : null;
}

// ---------------------------------------------------------------------------------------------
// Availability and options

export function mediaUnavailableReason(source: FormatId, target: FormatId, toolchain: ToolchainSnapshot): string | null {
  if (!toolchain.tools.ffmpeg.found) return 'FFmpeg is not installed.';
  if (!toolchain.tools.ffprobe.found) return 'FFprobe is not installed (it normally comes with FFmpeg).';
  const encoders = ffmpegEncoders(toolchain);
  const sourceIsAudioOnly = AUDIO_FORMATS.includes(source);

  if (AUDIO_FORMATS.includes(target)) {
    switch (target) {
      case 'mp3':
        return has(encoders, 'libmp3lame') ? null : 'This FFmpeg build has no MP3 encoder (libmp3lame).';
      case 'aac':
      case 'm4a':
        return has(encoders, 'aac') ? null : 'This FFmpeg build has no AAC encoder.';
      case 'ogg':
        return has(encoders, 'libvorbis') || has(encoders, 'libopus') ? null : 'This FFmpeg build has no Vorbis or Opus encoder.';
      case 'flac':
        return has(encoders, 'flac') ? null : 'This FFmpeg build has no FLAC encoder.';
      case 'wav':
        return has(encoders, 'pcm_s16le') ? null : 'This FFmpeg build has no PCM encoder.';
      default:
        return null;
    }
  }

  if (sourceIsAudioOnly) return 'Audio files cannot be converted to video.';

  const container = outputExtension(target);
  const codecs = availableVideoCodecs(container, encoders);
  if (codecs.length === 0) {
    return `This FFmpeg build has no video encoder suitable for ${FORMATS[target].label}.`;
  }
  if (!pickContainerAudioEncoder(container, encoders)) return `This FFmpeg build has no audio encoder suitable for ${FORMATS[target].label}.`;
  return null;
}

const sampleRateSpec: OptionSpec = {
  key: 'sampleRate',
  type: 'select',
  label: 'Sample rate',
  default: 'original',
  choices: [
    { value: 'original', label: 'Keep original' },
    { value: '22050', label: '22.05 kHz' },
    { value: '44100', label: '44.1 kHz' },
    { value: '48000', label: '48 kHz' },
    { value: '96000', label: '96 kHz' },
  ],
};

const bitrateChoices = ['64', '96', '128', '160', '192', '256', '320'].map((v) => ({ value: v, label: `${v} kbps` }));

export function audioOptionSpecs(target: FormatId): OptionSpec[] {
  switch (target) {
    case 'mp3':
      return [{ key: 'bitrate', type: 'select', label: 'Bitrate', default: '192', choices: bitrateChoices }, sampleRateSpec];
    case 'aac':
    case 'm4a':
      return [{ key: 'bitrate', type: 'select', label: 'Bitrate', default: '192', choices: bitrateChoices }, sampleRateSpec];
    case 'ogg':
      return [{ key: 'oggQuality', type: 'range', label: 'Quality', min: 0, max: 10, step: 1, default: 5, help: '0 is smallest, 10 is best. 5 is roughly 160 kbps.' }, sampleRateSpec];
    case 'wav':
      return [
        {
          key: 'bitDepth',
          type: 'select',
          label: 'Bit depth',
          default: '16',
          choices: [
            { value: '16', label: '16-bit' },
            { value: '24', label: '24-bit' },
          ],
        },
        sampleRateSpec,
      ];
    case 'flac':
      return [sampleRateSpec];
    default:
      return [];
  }
}

export function videoOptionSpecs(target: FormatId, toolchain: ToolchainSnapshot): OptionSpec[] {
  const container = outputExtension(target);
  const encoders = ffmpegEncoders(toolchain);
  const codecs = availableVideoCodecs(container, encoders);
  return [
    {
      key: 'mode',
      type: 'select',
      label: 'Method',
      default: 'auto',
      choices: [
        { value: 'auto', label: 'Automatic', description: 'Copies streams without re-encoding when the container allows it' },
        { value: 'reencode', label: 'Always re-encode', description: 'Slower, lets you change quality and codec' },
      ],
      help: 'Copying only changes the container, so it is fast and lossless.',
    },
    {
      key: 'videoCodec',
      type: 'select',
      label: 'Video codec',
      default: 'auto',
      choices: [
        { value: 'auto', label: 'Automatic', description: 'Keeps the original codec when the container allows it' },
        ...codecs.map((c) => ({ value: c, label: VIDEO_CODECS[c].label })),
      ],
      help: 'Choosing a specific codec re-encodes the video unless it already uses that codec.',
    },
    {
      key: 'quality',
      type: 'select',
      label: 'Quality',
      default: 'balanced',
      choices: [
        { value: 'high', label: 'High', description: 'Larger file' },
        { value: 'balanced', label: 'Balanced' },
        { value: 'small', label: 'Small file' },
      ],
    },
    {
      key: 'maxHeight',
      type: 'select',
      label: 'Resolution',
      default: 'original',
      choices: [
        { value: 'original', label: 'Keep original' },
        { value: '2160', label: 'Up to 2160p (4K)' },
        { value: '1440', label: 'Up to 1440p' },
        { value: '1080', label: 'Up to 1080p' },
        { value: '720', label: 'Up to 720p' },
        { value: '480', label: 'Up to 480p' },
        { value: '360', label: 'Up to 360p' },
      ],
      help: 'Videos are only scaled down, never enlarged.',
    },
  ];
}

export function mediaNotes(source: FormatId, target: FormatId): string[] {
  const notes: string[] = [];
  if (VIDEO_FORMATS.includes(source) && AUDIO_FORMATS.includes(target)) notes.push('Only the audio track is extracted.');
  if (AUDIO_FORMATS.includes(source) && AUDIO_FORMATS.includes(target) && FORMATS[source].lossy && FORMATS[target].lossy) {
    notes.push('Converting between lossy formats lowers quality slightly each time. Keep the original for the best results.');
  }
  if (VIDEO_FORMATS.includes(target)) notes.push('Subtitle tracks and extra video streams are not copied.');
  return notes;
}

// ---------------------------------------------------------------------------------------------
// Command construction (pure, unit-tested)

export interface MediaPlan {
  args: string[];
  /** Human summary for logs / tests, e.g. "video: copy, audio: aac". */
  summary: string;
  warnings: string[];
}

const CRF: Record<string, Record<'high' | 'balanced' | 'small', number>> = {
  libx264: { high: 18, balanced: 23, small: 28 },
  libx265: { high: 22, balanced: 28, small: 32 },
  'libvpx-vp9': { high: 24, balanced: 32, small: 40 },
  libsvtav1: { high: 24, balanced: 32, small: 40 },
  'libaom-av1': { high: 24, balanced: 32, small: 40 },
};
const MPEG4_Q: Record<'high' | 'balanced' | 'small', number> = { high: 3, balanced: 5, small: 9 };

function sampleRateArgs(options: EngineContext['options']): string[] {
  const rate = optString(options, 'sampleRate');
  return rate === 'original' ? [] : ['-ar', rate];
}

export function buildAudioPlan(input: string, output: string, target: FormatId, options: EngineContext['options'], info: MediaInfo, encoders: readonly string[]): MediaPlan {
  if (info.audioStreams.length === 0) throw new MorphError('INVALID_INPUT', 'This file has no audio track to convert.');
  const base = ['-nostdin', '-hide_banner', '-y', '-i', input, '-map', '0:a:0', '-vn', '-map_metadata', '0'];
  const warnings: string[] = [];
  if (info.audioStreams.length > 1) warnings.push(`The file has ${info.audioStreams.length} audio tracks. Only the first one was converted.`);
  const sr = sampleRateArgs(options);
  let codecArgs: string[];
  switch (target) {
    case 'mp3':
      codecArgs = ['-c:a', 'libmp3lame', '-b:a', `${optString(options, 'bitrate')}k`, ...sr, '-id3v2_version', '3'];
      break;
    case 'aac':
      codecArgs = ['-c:a', 'aac', '-b:a', `${optString(options, 'bitrate')}k`, ...sr, '-f', 'adts'];
      break;
    case 'm4a':
      codecArgs = ['-c:a', 'aac', '-b:a', `${optString(options, 'bitrate')}k`, ...sr, '-movflags', '+faststart', '-f', 'ipod'];
      break;
    case 'ogg': {
      const q = optNumber(options, 'oggQuality');
      if (has(encoders, 'libvorbis')) codecArgs = ['-c:a', 'libvorbis', '-q:a', String(q), ...sr];
      else codecArgs = ['-c:a', 'libopus', '-b:a', `${Math.round(64 + q * 19)}k`, ...(sr.length ? ['-ar', '48000'] : []), '-f', 'ogg'];
      break;
    }
    case 'wav':
      codecArgs = ['-c:a', optString(options, 'bitDepth') === '24' ? 'pcm_s24le' : 'pcm_s16le', ...sr];
      break;
    case 'flac':
      codecArgs = ['-c:a', 'flac', ...sr];
      break;
    default:
      throw new MorphError('UNSUPPORTED_FORMAT', 'That audio format is not supported.');
  }
  return { args: [...base, ...codecArgs, '-progress', 'pipe:1', '-nostats', '-stats_period', '0.2', output], summary: `audio: ${codecArgs[1] ?? ''}`, warnings };
}

export function buildVideoPlan(input: string, output: string, target: FormatId, options: EngineContext['options'], info: MediaInfo, encoders: readonly string[]): MediaPlan {
  const container = outputExtension(target);
  const video = info.videoStreams[0];
  if (!video) throw new MorphError('INVALID_INPUT', 'This file has no video track to convert.');
  const warnings: string[] = [];

  const mode = optString(options, 'mode');
  const quality = optString(options, 'quality') as 'high' | 'balanced' | 'small';
  const maxHeight = optString(options, 'maxHeight');
  const requestedCodec = optString(options, 'videoCodec');
  const allowed = availableVideoCodecs(container, encoders);
  const codec: VideoCodecId = allowed.find((c) => c === requestedCodec) ?? allowed[0] ?? 'h264';

  const needsScale = maxHeight !== 'original' && (video.height ?? 0) > Number(maxHeight);
  const codecAcceptable = requestedCodec === 'auto' || VIDEO_CODECS[codec].probeName.includes(video.codec);
  const copyVideo = mode === 'auto' && !needsScale && codecAcceptable && (COPYABLE_VIDEO[container] ?? []).includes(video.codec);

  const audio = info.audioStreams[0];
  const copyAudio = audio !== undefined && mode === 'auto' && (COPYABLE_AUDIO[container] ?? []).includes(audio.codec);

  if (!needsScale && maxHeight !== 'original') warnings.push('The video is already at or below the chosen resolution, so it was not scaled.');

  const args: string[] = ['-nostdin', '-hide_banner', '-y', '-i', input, '-map', `0:${video.index}`, '-map', '0:a?', '-sn', '-dn', '-map_metadata', '0'];
  const parts: string[] = [];

  if (copyVideo) {
    args.push('-c:v', 'copy');
    parts.push('video: copy');
  } else {
    const encoder = pickVideoEncoder(codec, encoders);
    if (!encoder) throw new MorphError('ENCODER_MISSING', `This FFmpeg build cannot encode ${VIDEO_CODECS[codec].label}.`);
    args.push('-c:v', encoder);
    const crf = CRF[encoder];
    if (crf) {
      args.push('-crf', String(crf[quality]));
      if (encoder === 'libx264' || encoder === 'libx265') args.push('-preset', 'medium');
      if (encoder === 'libx265' && (container === 'mp4' || container === 'mov')) args.push('-tag:v', 'hvc1');
      if (encoder === 'libvpx-vp9') args.push('-b:v', '0', '-row-mt', '1', '-deadline', 'good', '-cpu-used', '2');
      if (encoder === 'libaom-av1') args.push('-b:v', '0', '-cpu-used', '6', '-row-mt', '1');
      if (encoder === 'libsvtav1') args.push('-preset', '8');
    } else if (encoder === 'mpeg4') {
      args.push('-q:v', String(MPEG4_Q[quality]));
    }
    const filters = needsScale ? [`scale=-2:${Number(maxHeight)}`] : ['scale=trunc(iw/2)*2:trunc(ih/2)*2'];
    args.push('-vf', filters.join(','), '-pix_fmt', 'yuv420p');
    parts.push(`video: ${encoder}`);
  }

  if (audio) {
    if (copyAudio) {
      args.push('-c:a', 'copy');
      parts.push('audio: copy');
    } else {
      const enc = pickContainerAudioEncoder(container, encoders);
      if (!enc) throw new MorphError('ENCODER_MISSING', `This FFmpeg build has no audio encoder for ${FORMATS[target].label}.`);
      args.push('-c:a', enc.encoder, '-b:a', enc.bitrate);
      parts.push(`audio: ${enc.encoder}`);
    }
  }

  if (container === 'mp4' || container === 'mov') args.push('-movflags', '+faststart');
  if (info.subtitleCount > 0) warnings.push('Subtitle tracks are not included in the converted video.');
  if (info.audioStreams.length > 1) warnings.push(`All ${info.audioStreams.length} audio tracks were kept.`);
  args.push('-progress', 'pipe:1', '-nostats', '-stats_period', '0.2', output);
  return { args, summary: parts.join(', '), warnings };
}

// ---------------------------------------------------------------------------------------------
// Execution

export async function convertMedia(ctx: EngineContext): Promise<EngineResult> {
  const ffmpeg = requireToolPath(ctx.toolchain, 'ffmpeg', 'audio and video conversion');
  const ffprobe = requireToolPath(ctx.toolchain, 'ffprobe', 'audio and video conversion');
  const encoders = ffmpegEncoders(ctx.toolchain);
  const target = ctx.targetFormat;
  const ext = outputExtension(target);

  ctx.report({ phase: 'Reading media', progress: null });
  const info = await probeMedia(ffprobe, ctx.sourcePath, ctx.signal);
  const output = path.join(ctx.workDir, `output.${ext}`);

  const plan = AUDIO_FORMATS.includes(target)
    ? buildAudioPlan(ctx.sourcePath, output, target, ctx.options, info, encoders)
    : buildVideoPlan(ctx.sourcePath, output, target, ctx.options, info, encoders);
  for (const warning of plan.warnings) ctx.warn(warning);
  ctx.log.info('ffmpeg plan', { summary: plan.summary });

  const duration = info.durationSec;
  ctx.report({ phase: plan.summary.includes('video: copy') && !plan.summary.includes('audio:') ? 'Copying streams' : 'Encoding', progress: duration ? 0 : null });

  const result = await runProcess(ffmpeg, plan.args, {
    signal: ctx.signal,
    onStdoutLine(line) {
      const match = /^out_time_(?:us|ms)=(\d+)/.exec(line);
      if (match?.[1] && duration) {
        // Both out_time_us and out_time_ms are reported in microseconds by FFmpeg.
        const seconds = Number(match[1]) / 1_000_000;
        ctx.report({ progress: Math.max(0, Math.min(0.99, seconds / duration)) });
      }
    },
  });

  const stat = await fs.stat(output).catch(() => null);
  if (result.code !== 0 || !stat || stat.size === 0) {
    const detail = tailLines(result.stderr);
    if (/Unknown encoder|Encoder .* not found/i.test(detail)) throw new MorphError('ENCODER_MISSING', 'This FFmpeg build is missing a required encoder.', { detail });
    if (/Invalid data found|moov atom not found|could not find codec/i.test(detail)) throw new MorphError('CORRUPT_INPUT', 'The media file is damaged or uses an unsupported codec.', { detail });
    throw new MorphError('TOOL_FAILED', 'FFmpeg could not convert this file.', { detail });
  }
  ctx.report({ progress: 1 });
  return { files: [{ path: output, name: `${ctx.baseName}.${ext}` }], packaging: 'single' };
}
