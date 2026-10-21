/**
 * Format catalogue. A format listed here is only *offered* to users when the conversion registry
 * (src/core/registry.ts) has a working conversion path for it.
 */
export const FORMAT_IDS = [
  'png', 'jpg', 'webp', 'avif', 'bmp', 'tiff', 'gif', 'ico',
  'pdf', 'docx', 'doc', 'odt', 'txt',
  'mp3', 'wav', 'flac', 'aac', 'ogg', 'm4a',
  'mp4', 'mkv', 'mov', 'webm', 'avi',
] as const;

export type FormatId = (typeof FORMAT_IDS)[number];
export type Category = 'image' | 'document' | 'audio' | 'video';

export interface FormatInfo {
  id: FormatId;
  label: string;
  category: Category;
  /** Primary extension first (without the dot). */
  extensions: readonly string[];
  mime: string;
  supportsTransparency?: boolean;
  supportsAnimation?: boolean;
  lossy?: boolean;
}

const f = (info: FormatInfo): FormatInfo => info;

export const FORMATS: Readonly<Record<FormatId, FormatInfo>> = {
  png: f({ id: 'png', label: 'PNG', category: 'image', extensions: ['png'], mime: 'image/png', supportsTransparency: true }),
  jpg: f({ id: 'jpg', label: 'JPG', category: 'image', extensions: ['jpg', 'jpeg', 'jpe', 'jfif'], mime: 'image/jpeg', lossy: true }),
  webp: f({ id: 'webp', label: 'WebP', category: 'image', extensions: ['webp'], mime: 'image/webp', supportsTransparency: true, supportsAnimation: true, lossy: true }),
  avif: f({ id: 'avif', label: 'AVIF', category: 'image', extensions: ['avif'], mime: 'image/avif', supportsTransparency: true, lossy: true }),
  bmp: f({ id: 'bmp', label: 'BMP', category: 'image', extensions: ['bmp', 'dib'], mime: 'image/bmp' }),
  tiff: f({ id: 'tiff', label: 'TIFF', category: 'image', extensions: ['tiff', 'tif'], mime: 'image/tiff', supportsTransparency: true }),
  gif: f({ id: 'gif', label: 'GIF', category: 'image', extensions: ['gif'], mime: 'image/gif', supportsTransparency: true, supportsAnimation: true }),
  ico: f({ id: 'ico', label: 'ICO', category: 'image', extensions: ['ico'], mime: 'image/vnd.microsoft.icon', supportsTransparency: true }),

  pdf: f({ id: 'pdf', label: 'PDF', category: 'document', extensions: ['pdf'], mime: 'application/pdf' }),
  docx: f({ id: 'docx', label: 'Word (DOCX)', category: 'document', extensions: ['docx', 'docm'], mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }),
  doc: f({ id: 'doc', label: 'Word 97–2003 (DOC)', category: 'document', extensions: ['doc'], mime: 'application/msword' }),
  odt: f({ id: 'odt', label: 'OpenDocument Text (ODT)', category: 'document', extensions: ['odt'], mime: 'application/vnd.oasis.opendocument.text' }),
  txt: f({ id: 'txt', label: 'Plain text (TXT)', category: 'document', extensions: ['txt', 'text', 'log'], mime: 'text/plain' }),

  mp3: f({ id: 'mp3', label: 'MP3', category: 'audio', extensions: ['mp3'], mime: 'audio/mpeg', lossy: true }),
  wav: f({ id: 'wav', label: 'WAV', category: 'audio', extensions: ['wav', 'wave'], mime: 'audio/wav' }),
  flac: f({ id: 'flac', label: 'FLAC', category: 'audio', extensions: ['flac'], mime: 'audio/flac' }),
  aac: f({ id: 'aac', label: 'AAC', category: 'audio', extensions: ['aac'], mime: 'audio/aac', lossy: true }),
  ogg: f({ id: 'ogg', label: 'OGG', category: 'audio', extensions: ['ogg', 'oga'], mime: 'audio/ogg', lossy: true }),
  m4a: f({ id: 'm4a', label: 'M4A', category: 'audio', extensions: ['m4a', 'm4b'], mime: 'audio/mp4', lossy: true }),

  mp4: f({ id: 'mp4', label: 'MP4', category: 'video', extensions: ['mp4', 'm4v', '3gp'], mime: 'video/mp4' }),
  mkv: f({ id: 'mkv', label: 'MKV', category: 'video', extensions: ['mkv'], mime: 'video/x-matroska' }),
  mov: f({ id: 'mov', label: 'MOV', category: 'video', extensions: ['mov', 'qt'], mime: 'video/quicktime' }),
  webm: f({ id: 'webm', label: 'WebM', category: 'video', extensions: ['webm'], mime: 'video/webm' }),
  avi: f({ id: 'avi', label: 'AVI', category: 'video', extensions: ['avi'], mime: 'video/x-msvideo' }),
};

export function isFormatId(value: unknown): value is FormatId {
  return typeof value === 'string' && (FORMAT_IDS as readonly string[]).includes(value);
}

/** Extension used for files Morph writes (no dot). */
export function outputExtension(format: FormatId): string {
  return FORMATS[format].extensions[0] ?? format;
}

/** Maps a file extension (no dot, any case) to the format ids that claim it. */
export function formatForExtension(ext: string): FormatId | null {
  const e = ext.toLowerCase().replace(/^\./, '');
  for (const id of FORMAT_IDS) {
    if (FORMATS[id].extensions.includes(e)) return id;
  }
  return null;
}
