import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { MorphError, toErrorInfo } from '../shared/errors';
import { FORMATS, type FormatId } from '../shared/formats';
import type { FileDetails, InspectResult, InspectedFile, ToolchainSnapshot } from '../shared/types';
import { detectFile } from './detect';
import { inspectImage, IMAGE_FORMATS, type QualityDefaults } from './engines/image';
import { AUDIO_FORMATS, VIDEO_FORMATS, inspectMedia } from './engines/media';
import { inspectPdf } from './engines/pdf';
import { baseNameWithoutExtension, statRegularFile } from './fsutil';
import { describeTargets } from './registry';

/** A file the user handed to Morph, remembered by an opaque id so conversions never re-accept raw paths. */
export interface RegisteredFile {
  id: string;
  /** Path as given (shown to the user; its folder is the default output folder). */
  path: string;
  /** Path with symlinks resolved; reads happen here. */
  realPath: string;
  size: number;
  mtimeMs: number;
  format: FormatId;
  baseName: string;
}

const MAX_REGISTERED = 500;

export class FileRegistry {
  private readonly files = new Map<string, RegisteredFile>();

  add(file: Omit<RegisteredFile, 'id'>): RegisteredFile {
    const entry: RegisteredFile = { ...file, id: randomUUID() };
    this.files.set(entry.id, entry);
    if (this.files.size > MAX_REGISTERED) {
      const oldest = this.files.keys().next().value;
      if (oldest !== undefined) this.files.delete(oldest);
    }
    return entry;
  }

  get(id: string): RegisteredFile | undefined {
    return this.files.get(id);
  }

  get size(): number {
    return this.files.size;
  }
}

export interface InspectEnv {
  toolchain: ToolchainSnapshot;
  quality: QualityDefaults;
}

async function detailsFor(realPath: string, format: FormatId, env: InspectEnv): Promise<{ details: FileDetails; preview?: string }> {
  if (IMAGE_FORMATS.includes(format)) return inspectImage(realPath, format, true);
  if (format === 'pdf') return { details: await inspectPdf(realPath) };
  if (AUDIO_FORMATS.includes(format) || VIDEO_FORMATS.includes(format)) return { details: await inspectMedia(env.toolchain, realPath) };
  return { details: {} };
}

/** Validates, identifies and describes one file, and registers it for later conversion. */
export async function inspectFile(inputPath: string, registry: FileRegistry, env: InspectEnv): Promise<InspectedFile> {
  const stat = await statRegularFile(inputPath);
  const detection = await detectFile(stat.realPath);
  if (detection.format === null) {
    throw new MorphError(detection.corrupt ? 'CORRUPT_INPUT' : 'UNSUPPORTED_FORMAT', detection.unsupportedReason ?? 'This file type is not supported.', { detail: detection.description });
  }
  const format = detection.format;
  const { details, preview } = await detailsFor(stat.realPath, format, env);
  const info = FORMATS[format];

  const registered = registry.add({
    path: inputPath,
    realPath: stat.realPath,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    format,
    baseName: baseNameWithoutExtension(inputPath),
  });

  const notes = [...detection.notes];
  if (path.resolve(inputPath) !== stat.realPath && path.basename(inputPath) !== path.basename(stat.realPath)) {
    notes.push('This is a shortcut or link. The original file it points to is used, and the result is saved next to the link.');
  }

  const file: InspectedFile = {
    id: registered.id,
    path: inputPath,
    name: path.basename(inputPath),
    directory: path.dirname(inputPath),
    size: stat.size,
    format,
    formatLabel: info.label,
    category: info.category,
    description: detection.description,
    extensionMismatch: detection.extensionMismatch,
    notes,
    details,
    targets: describeTargets(format, env),
  };
  if (preview) file.preview = preview;
  return file;
}

export async function inspectFiles(paths: readonly string[], registry: FileRegistry, env: InspectEnv): Promise<InspectResult> {
  const files: InspectedFile[] = [];
  const rejected: InspectResult['rejected'] = [];
  const seen = new Set<string>();
  for (const p of paths) {
    const key = process.platform === 'win32' ? p.toLowerCase() : p;
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      files.push(await inspectFile(p, registry, env));
    } catch (error) {
      rejected.push({ name: path.basename(p), path: p, error: toErrorInfo(error) });
    }
  }
  return { files, rejected };
}
