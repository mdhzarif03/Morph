import type { ToolId, ToolStatus, ToolchainSnapshot } from '../../src/shared/types';

const LABELS: Record<ToolId, string> = { ffmpeg: 'FFmpeg', ffprobe: 'FFprobe', soffice: 'LibreOffice', pdftoppm: 'Poppler (pdftoppm)', pdfinfo: 'Poppler (pdfinfo)' };

export const ALL_ENCODERS = ['aac', 'ac3', 'flac', 'libmp3lame', 'libopus', 'libvorbis', 'libvpx-vp9', 'libx264', 'libx265', 'libsvtav1', 'mpeg4', 'pcm_s16le', 'pcm_s24le'];

/** Builds a synthetic toolchain snapshot. Tools not listed in `present` are reported missing. */
export function fakeToolchain(present: ToolId[] = [], encoders: string[] = ALL_ENCODERS): ToolchainSnapshot {
  const tools = Object.fromEntries(
    (Object.keys(LABELS) as ToolId[]).map((id): [ToolId, ToolStatus] => {
      const found = present.includes(id);
      const status: ToolStatus = { id, label: LABELS[id], found, neededFor: 'testing', installHint: `Install ${LABELS[id]}.` };
      if (found) {
        status.path = `/fake/${id}`;
        status.source = 'system-path';
      }
      if (id === 'ffmpeg' && found) status.encoders = encoders;
      return [id, status];
    }),
  ) as Record<ToolId, ToolStatus>;
  return { tools, checkedAt: 0 };
}

export const EVERYTHING = fakeToolchain(['ffmpeg', 'ffprobe', 'soffice', 'pdftoppm', 'pdfinfo']);
export const NOTHING = fakeToolchain([]);
