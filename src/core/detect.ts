import { promises as fs } from 'node:fs';
import path from 'node:path';
import yauzl from 'yauzl';
import { FORMATS, formatForExtension, type FormatId } from '../shared/formats';

/**
 * Content-based file type detection. The extension is *never* trusted: it is only compared with the
 * detected type so that misleadingly named files can be flagged.
 */
export interface Detection {
  /** A supported input format, or null when the file is unsupported or unrecognised. */
  format: FormatId | null;
  /** Human description of what the content actually is. */
  description: string;
  /** Lower-case extension without the dot ('' when none). */
  extension: string;
  /** True when the extension does not match the detected content. */
  extensionMismatch: boolean;
  notes: string[];
  /** Set when `format` is null: why Morph cannot convert it. */
  unsupportedReason?: string;
  /** True when the file looks like a supported container but is damaged. */
  corrupt?: boolean;
}

const HEADER_BYTES = 65_536;
const MAX_ZIP_ENTRIES_SCANNED = 5000;

type Sniff = { format: FormatId; description: string; notes?: string[] } | { format: null; description: string; unsupportedReason: string; corrupt?: boolean };

function ascii(buf: Buffer, start: number, end: number): string {
  return buf.toString('latin1', start, end);
}

function startsWith(buf: Buffer, bytes: readonly number[], offset = 0): boolean {
  if (buf.length < offset + bytes.length) return false;
  return bytes.every((b, i) => buf[offset + i] === b);
}

async function readHead(filePath: string, length: number): Promise<{ buf: Buffer; size: number }> {
  const handle = await fs.open(filePath, 'r');
  try {
    const { size } = await handle.stat();
    const buf = Buffer.alloc(Math.min(length, size));
    const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
    return { buf: buf.subarray(0, bytesRead), size };
  } finally {
    await handle.close();
  }
}

async function readAt(filePath: string, position: number, length: number): Promise<Buffer> {
  const handle = await fs.open(filePath, 'r');
  try {
    const buf = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buf, 0, length, position);
    return buf.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

// ---------------------------------------------------------------------------------------------
// ZIP based containers (DOCX, ODT, XLSX, PPTX, plain ZIP)

interface ZipProbe {
  names: Set<string>;
  mimetype?: string;
}

function probeZip(filePath: string): Promise<ZipProbe | null> {
  return new Promise((resolve) => {
    yauzl.open(filePath, { lazyEntries: true, autoClose: true, strictFileNames: false }, (openError, zip) => {
      if (openError || !zip) {
        resolve(null);
        return;
      }
      const names = new Set<string>();
      let mimetype: string | undefined;
      let count = 0;
      let done = false;
      const finish = (value: ZipProbe | null) => {
        if (done) return;
        done = true;
        zip.close();
        resolve(value);
      };
      zip.on('error', () => finish(null));
      zip.on('end', () => finish({ names, mimetype }));
      zip.on('entry', (entry: yauzl.Entry) => {
        count += 1;
        names.add(entry.fileName);
        if (count > MAX_ZIP_ENTRIES_SCANNED) {
          finish({ names, mimetype });
          return;
        }
        if (entry.fileName === 'mimetype' && entry.uncompressedSize < 256) {
          zip.openReadStream(entry, (streamError, stream) => {
            if (streamError || !stream) {
              zip.readEntry();
              return;
            }
            const chunks: Buffer[] = [];
            stream.on('data', (c: Buffer) => chunks.push(c));
            stream.on('end', () => {
              mimetype = Buffer.concat(chunks).toString('utf8').trim();
              zip.readEntry();
            });
            stream.on('error', () => zip.readEntry());
          });
          return;
        }
        zip.readEntry();
      });
      zip.readEntry();
    });
  });
}

async function sniffZip(filePath: string): Promise<Sniff> {
  const probe = await probeZip(filePath);
  if (!probe) {
    return { format: null, description: 'ZIP archive', unsupportedReason: 'This looks like a ZIP-based file (such as a DOCX or ODT), but its contents could not be read. It may be damaged or incomplete.', corrupt: true };
  }
  const { names, mimetype } = probe;
  if (names.has('word/document.xml')) return { format: 'docx', description: 'Word document (DOCX)' };
  if (mimetype === 'application/vnd.oasis.opendocument.text') return { format: 'odt', description: 'OpenDocument text (ODT)' };
  if (names.has('xl/workbook.xml')) return { format: null, description: 'Excel workbook (XLSX)', unsupportedReason: 'Spreadsheet conversion is not supported yet.' };
  if (names.has('ppt/presentation.xml')) return { format: null, description: 'PowerPoint presentation (PPTX)', unsupportedReason: 'Presentation conversion is not supported yet.' };
  if (mimetype?.startsWith('application/vnd.oasis.opendocument.')) {
    return { format: null, description: 'OpenDocument file', unsupportedReason: 'Only OpenDocument text (ODT) files are supported.' };
  }
  if (mimetype === 'application/epub+zip') return { format: null, description: 'EPUB book', unsupportedReason: 'E-book conversion is not supported yet.' };
  return { format: null, description: 'ZIP archive', unsupportedReason: 'Archive conversion is not supported yet.' };
}

// ---------------------------------------------------------------------------------------------
// Legacy OLE2 (DOC, XLS, PPT): look for the directory entry name rather than trusting the extension.

async function ole2ContainsName(filePath: string, name: string, maxBytes = 64 * 1024 * 1024): Promise<boolean> {
  const needle = Buffer.from(name, 'utf16le');
  const handle = await fs.open(filePath, 'r');
  try {
    const { size } = await handle.stat();
    const limit = Math.min(size, maxBytes);
    const chunkSize = 1024 * 1024;
    const overlap = needle.length - 1;
    const buf = Buffer.alloc(chunkSize + overlap);
    let position = 0;
    let carry = 0;
    while (position < limit) {
      const { bytesRead } = await handle.read(buf, carry, Math.min(chunkSize, limit - position), position);
      if (bytesRead === 0) break;
      const window = buf.subarray(0, carry + bytesRead);
      if (window.indexOf(needle) !== -1) return true;
      carry = Math.min(overlap, window.length);
      window.copy(buf, 0, window.length - carry);
      position += bytesRead;
    }
    return false;
  } finally {
    await handle.close();
  }
}

async function sniffOle(filePath: string): Promise<Sniff> {
  if (await ole2ContainsName(filePath, 'WordDocument')) return { format: 'doc', description: 'Word 97–2003 document (DOC)' };
  if (await ole2ContainsName(filePath, 'Workbook')) {
    return { format: null, description: 'Excel 97–2003 workbook (XLS)', unsupportedReason: 'Spreadsheet conversion is not supported yet.' };
  }
  if (await ole2ContainsName(filePath, 'PowerPoint Document')) {
    return { format: null, description: 'PowerPoint 97–2003 presentation (PPT)', unsupportedReason: 'Presentation conversion is not supported yet.' };
  }
  return { format: null, description: 'Legacy Microsoft Office file', unsupportedReason: 'Only Word documents (.doc, .docx) are supported.' };
}

// ---------------------------------------------------------------------------------------------
// Audio / video

const MP3_BITRATES: Record<string, readonly number[]> = {
  'v1-l1': [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
  'v1-l2': [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
  'v1-l3': [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  'v2-l1': [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
  'v2-l2': [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
  'v2-l3': [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
};
const MP3_SAMPLE_RATES: Record<number, readonly number[]> = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };

/** Length in bytes of the MPEG audio frame starting at `o`, or 0 when no valid header is there. */
function mp3FrameLength(b: Buffer, o: number): number {
  if (b.length < o + 4 || b[o] !== 0xff || ((b[o + 1] ?? 0) & 0xe0) !== 0xe0) return 0;
  const b1 = b[o + 1] ?? 0;
  const b2 = b[o + 2] ?? 0;
  const version = (b1 >> 3) & 3; // 3 = MPEG1, 2 = MPEG2, 0 = MPEG2.5, 1 = reserved
  const layer = (b1 >> 1) & 3; // 3 = I, 2 = II, 1 = III, 0 = reserved
  const bitrateIndex = (b2 >> 4) & 0xf;
  const rateIndex = (b2 >> 2) & 3;
  const padding = (b2 >> 1) & 1;
  if (version === 1 || layer === 0 || bitrateIndex === 0 || bitrateIndex === 0xf || rateIndex === 3) return 0;
  const key = `${version === 3 ? 'v1' : 'v2'}-l${4 - layer}`;
  const bitrate = (MP3_BITRATES[key]?.[bitrateIndex] ?? 0) * 1000;
  const sampleRate = MP3_SAMPLE_RATES[version]?.[rateIndex] ?? 0;
  if (bitrate === 0 || sampleRate === 0) return 0;
  if (layer === 3) return (Math.floor((12 * bitrate) / sampleRate) + padding) * 4;
  const coefficient = layer === 1 && version !== 3 ? 72 : 144;
  return Math.floor((coefficient * bitrate) / sampleRate) + padding;
}

/** A bare MP3 stream must show a valid frame followed by another valid frame (the 64 KB header always has room). */
function isMp3Stream(b: Buffer, o: number): boolean {
  const length = mp3FrameLength(b, o);
  if (length === 0) return false;
  const next = o + length;
  return mp3FrameLength(b, next) > 0;
}

function adtsFrameLength(b: Buffer, o: number): number {
  if (b.length < o + 7 || b[o] !== 0xff) return 0;
  const b1 = b[o + 1] ?? 0;
  const b2 = b[o + 2] ?? 0;
  if ((b1 & 0xf6) !== 0xf0 || ((b2 >> 2) & 0xf) >= 13) return 0;
  return (((b[o + 3] ?? 0) & 0x03) << 11) | ((b[o + 4] ?? 0) << 3) | ((b[o + 5] ?? 0) >> 5);
}

function isAdtsStream(b: Buffer, o: number): boolean {
  const length = adtsFrameLength(b, o);
  if (length < 7) return false;
  const next = o + length;
  return adtsFrameLength(b, next) >= 7;
}

function sniffFtyp(buf: Buffer): Sniff | null {
  if (buf.length < 12 || ascii(buf, 4, 8) !== 'ftyp') return null;
  const major = ascii(buf, 8, 12);
  const boxSize = Math.min(buf.readUInt32BE(0), 512, buf.length);
  const compat: string[] = [];
  for (let o = 16; o + 4 <= boxSize; o += 4) compat.push(ascii(buf, o, o + 4));
  const brands = new Set([major, ...compat]);

  if (major === 'avif' || major === 'avis') return { format: 'avif', description: 'AVIF image' };
  if (['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1'].includes(major) && !brands.has('avif')) {
    return { format: null, description: 'HEIC / HEIF image', unsupportedReason: 'HEIC images are not supported because decoding them requires a patent-encumbered codec.' };
  }
  if (major === 'qt  ') return { format: 'mov', description: 'QuickTime movie (MOV)' };
  if (major === 'M4A ' || major === 'M4B ' || major === 'M4P ') return { format: 'm4a', description: 'M4A audio' };
  if (major.startsWith('3g')) return { format: 'mp4', description: '3GPP video', notes: ['3GP files are treated as MP4 video.'] };
  return { format: 'mp4', description: 'MP4 video' };
}

function sniffEbml(buf: Buffer): Sniff | null {
  if (!startsWith(buf, [0x1a, 0x45, 0xdf, 0xa3])) return null;
  const header = ascii(buf, 0, Math.min(buf.length, 256));
  if (header.includes('webm')) return { format: 'webm', description: 'WebM video' };
  return { format: 'mkv', description: 'Matroska video (MKV)' };
}

async function sniffId3(filePath: string, buf: Buffer): Promise<Sniff | null> {
  if (ascii(buf, 0, 3) !== 'ID3' || buf.length < 10) return null;
  const size = ((buf[6] ?? 0) << 21) | ((buf[7] ?? 0) << 14) | ((buf[8] ?? 0) << 7) | (buf[9] ?? 0);
  const footer = ((buf[5] ?? 0) & 0x10) !== 0 ? 10 : 0;
  const after = await readAt(filePath, 10 + size + footer, 16);
  if (ascii(after, 0, 4) === 'fLaC') return { format: 'flac', description: 'FLAC audio' };
  if (isAdtsStream(after, 0)) return { format: 'aac', description: 'AAC audio' };
  return { format: 'mp3', description: 'MP3 audio' };
}

// ---------------------------------------------------------------------------------------------
// Text

function looksLikeText(buf: Buffer): { text: boolean; encoding: string } {
  if (buf.length === 0) return { text: false, encoding: '' };
  if (startsWith(buf, [0xef, 0xbb, 0xbf])) return { text: true, encoding: 'UTF-8' };
  if (startsWith(buf, [0xff, 0xfe]) || startsWith(buf, [0xfe, 0xff])) return { text: true, encoding: 'UTF-16' };
  if (buf.includes(0)) return { text: false, encoding: '' };
  // Control characters other than tab / newline / carriage return / form feed suggest binary.
  let control = 0;
  for (const byte of buf) {
    if (byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d && byte !== 0x0c && byte !== 0x1b) control += 1;
  }
  if (control / buf.length > 0.01) return { text: false, encoding: '' };
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buf, { stream: true });
    return { text: true, encoding: 'UTF-8' };
  } catch {
    return { text: true, encoding: 'a legacy 8-bit encoding' };
  }
}

const TEXT_EXTENSIONS = new Set(['txt', 'text', 'log']);

// ---------------------------------------------------------------------------------------------

async function sniff(filePath: string, buf: Buffer, size: number, extension: string): Promise<Sniff> {
  // Images
  if (startsWith(buf, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { format: 'png', description: 'PNG image' };
  if (startsWith(buf, [0xff, 0xd8, 0xff])) return { format: 'jpg', description: 'JPEG image' };
  if (ascii(buf, 0, 6) === 'GIF87a' || ascii(buf, 0, 6) === 'GIF89a') return { format: 'gif', description: 'GIF image' };
  if (ascii(buf, 0, 4) === 'RIFF' && buf.length >= 12) {
    const kind = ascii(buf, 8, 12);
    if (kind === 'WEBP') return { format: 'webp', description: 'WebP image' };
    if (kind === 'WAVE') return { format: 'wav', description: 'WAV audio' };
    if (kind === 'AVI ') return { format: 'avi', description: 'AVI video' };
    return { format: null, description: 'RIFF container', unsupportedReason: 'This RIFF file type is not supported.' };
  }
  if (ascii(buf, 0, 2) === 'BM' && buf.length >= 18) {
    const dibSize = buf.readUInt32LE(14);
    if ([12, 40, 52, 56, 64, 108, 124].includes(dibSize)) return { format: 'bmp', description: 'BMP image' };
  }
  if (startsWith(buf, [0x49, 0x49, 0x2a, 0x00]) || startsWith(buf, [0x4d, 0x4d, 0x00, 0x2a]) || startsWith(buf, [0x49, 0x49, 0x2b, 0x00])) {
    return { format: 'tiff', description: 'TIFF image' };
  }
  if (startsWith(buf, [0x00, 0x00, 0x01, 0x00]) && buf.length >= 22 && (buf[9] ?? 1) === 0 && (buf.readUInt16LE(4) ?? 0) > 0) {
    return { format: 'ico', description: 'Windows icon (ICO)' };
  }
  if (startsWith(buf, [0x00, 0x00, 0x02, 0x00])) {
    return { format: null, description: 'Windows cursor (CUR)', unsupportedReason: 'Cursor files are not supported.' };
  }

  // Documents
  const pdfAt = ascii(buf, 0, Math.min(buf.length, 1024)).indexOf('%PDF-');
  if (pdfAt !== -1) return { format: 'pdf', description: 'PDF document' };
  if (startsWith(buf, [0x50, 0x4b, 0x03, 0x04]) || startsWith(buf, [0x50, 0x4b, 0x05, 0x06])) return sniffZip(filePath);
  if (startsWith(buf, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) return sniffOle(filePath);
  if (ascii(buf, 0, 5) === '{\\rtf') return { format: null, description: 'Rich Text Format (RTF)', unsupportedReason: 'RTF conversion is not supported yet.' };

  // Audio / video
  const id3 = await sniffId3(filePath, buf);
  if (id3) return id3;
  if (ascii(buf, 0, 4) === 'fLaC') return { format: 'flac', description: 'FLAC audio' };
  if (ascii(buf, 0, 4) === 'OggS') return { format: 'ogg', description: 'Ogg audio' };
  const ftyp = sniffFtyp(buf);
  if (ftyp) return ftyp;
  const ebml = sniffEbml(buf);
  if (ebml) return ebml;
  const utf16Bom = startsWith(buf, [0xff, 0xfe]) || startsWith(buf, [0xfe, 0xff]);
  if (!utf16Bom && isAdtsStream(buf, 0)) return { format: 'aac', description: 'AAC audio' };
  if (!utf16Bom && isMp3Stream(buf, 0)) return { format: 'mp3', description: 'MP3 audio' };

  // Other well-known but unsupported types, so the user gets a clear message.
  if (startsWith(buf, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])) return { format: null, description: '7-Zip archive', unsupportedReason: 'Archive conversion is not supported yet.' };
  if (startsWith(buf, [0x52, 0x61, 0x72, 0x21])) return { format: null, description: 'RAR archive', unsupportedReason: 'Archive conversion is not supported yet.' };
  if (startsWith(buf, [0x1f, 0x8b])) return { format: null, description: 'GZIP archive', unsupportedReason: 'Archive conversion is not supported yet.' };
  if (startsWith(buf, [0x38, 0x42, 0x50, 0x53])) return { format: null, description: 'Photoshop document (PSD)', unsupportedReason: 'Photoshop files are not supported.' };
  if (startsWith(buf, [0x4d, 0x5a])) return { format: null, description: 'Windows program', unsupportedReason: 'Programs cannot be converted.' };

  // Text-like
  const text = looksLikeText(buf);
  if (text.text) {
    const head = buf.toString('utf8', 0, Math.min(buf.length, 2048)).trimStart().toLowerCase();
    if (head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg'))) {
      return { format: null, description: 'SVG image', unsupportedReason: 'SVG conversion is not supported yet.' };
    }
    if (head.startsWith('<!doctype html') || head.startsWith('<html')) {
      return { format: null, description: 'HTML document', unsupportedReason: 'HTML to PDF is not supported yet.' };
    }
    if (TEXT_EXTENSIONS.has(extension)) {
      const notes: string[] = [];
      if (text.encoding === 'a legacy 8-bit encoding') notes.push('The text is not valid UTF-8; it will be read as Windows-1252, so some characters may look different.');
      if (size > 50 * 1024 * 1024) notes.push('This is a very large text file; the PDF will have many pages.');
      return { format: 'txt', description: `Plain text (${text.encoding})`, notes };
    }
    return {
      format: null,
      description: 'Text file',
      unsupportedReason: `Only .txt files are supported as plain text (this one is .${extension || 'unknown'}).`,
    };
  }

  return { format: null, description: 'Unknown file type', unsupportedReason: 'Morph does not recognise this file type.' };
}

export async function detectFile(filePath: string): Promise<Detection> {
  const extension = path.extname(filePath).replace(/^\./, '').toLowerCase();
  const { buf, size } = await readHead(filePath, HEADER_BYTES);
  const result = await sniff(filePath, buf, size, extension);

  const notes = result.format === null ? [] : [...(result.notes ?? [])];
  let extensionMismatch = false;
  if (result.format !== null) {
    const claimed = formatForExtension(extension);
    const detectedIsAlias = FORMATS[result.format].extensions.includes(extension);
    extensionMismatch = !detectedIsAlias && claimed !== result.format;
    if (extensionMismatch) {
      notes.push(
        extension === ''
          ? `The file has no extension. Morph identified it from its content as ${result.description}.`
          : `The file is named .${extension} but its content is ${result.description}. Morph uses the actual content.`,
      );
    }
  }

  const detection: Detection = {
    format: result.format,
    description: result.description,
    extension,
    extensionMismatch,
    notes,
  };
  if (result.format === null) {
    detection.unsupportedReason = result.unsupportedReason;
    if (result.corrupt) detection.corrupt = true;
  }
  return detection;
}
