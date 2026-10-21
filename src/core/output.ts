import { promises as fs, constants as fsc } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { MorphError, cancelledError } from '../shared/errors';
import type { JobOutput } from '../shared/types';
import type { EngineResult, WorkFile } from './engines/types';
import { freeBytes, sanitizeFileName } from './fsutil';
import { createZip } from './zip';

export interface OutputSettings {
  naming: 'same-name' | 'suffix';
  suffix: string;
  /** null = next to the source file. */
  directory: string | null;
}

const MAX_BASE_LENGTH = 150;
const MAX_COLLISION_ATTEMPTS = 10_000;
const SPACE_MARGIN_BYTES = 8 * 1024 * 1024;

/** Where outputs go: the source file's own folder unless the user chose another one. */
export function resolveOutputDirectory(sourcePath: string, settings: OutputSettings): string {
  return settings.directory ?? path.dirname(sourcePath);
}

/** `report` + `pdf` -> `report.pdf`, or `report_converted.pdf` with the suffix naming mode. */
export function outputFileName(baseName: string, extension: string, settings: OutputSettings): string {
  let stem = sanitizeFileName(baseName, 'file');
  if (stem.length > MAX_BASE_LENGTH) stem = stem.slice(0, MAX_BASE_LENGTH).replace(/[. ]+$/, '');
  if (settings.naming === 'suffix') stem += sanitizeSuffix(settings.suffix);
  return `${stem}.${extension}`;
}

function sanitizeSuffix(suffix: string): string {
  // Suffix is user-provided text: keep it to a harmless character set.
  return suffix.replace(/[^\w .()+-]/g, '').slice(0, 32);
}

/** `logo.webp` + 1 -> `logo (1).webp` */
export function withCollisionIndex(fileName: string, index: number): string {
  if (index === 0) return fileName;
  const ext = path.extname(fileName);
  const stem = fileName.slice(0, fileName.length - ext.length);
  return `${stem} (${index})${ext}`;
}

export interface Reservation {
  path: string;
  name: string;
}

/**
 * Atomically claims the first free file name in `directory`. The placeholder is created with the
 * exclusive flag (`wx`), so two jobs racing for `logo.webp` can never get the same name and an
 * existing file is never touched.
 */
export async function reserveOutputName(directory: string, fileName: string): Promise<Reservation> {
  for (let index = 0; index < MAX_COLLISION_ATTEMPTS; index += 1) {
    const name = withCollisionIndex(fileName, index);
    const candidate = path.join(directory, name);
    try {
      const handle = await fs.open(candidate, 'wx');
      await handle.close();
      return { path: candidate, name };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EEXIST') continue;
      if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') {
        throw new MorphError('PERMISSION_DENIED', 'Morph cannot save files in that folder. Choose another output folder in Settings.', { detail: candidate });
      }
      if (code === 'ENOENT') throw new MorphError('INVALID_INPUT', 'The output folder no longer exists.', { detail: directory });
      if (code === 'ENAMETOOLONG') throw new MorphError('INVALID_INPUT', 'The file name is too long to save here.', { detail: candidate });
      throw error;
    }
  }
  throw new MorphError('INTERNAL', 'Could not find a free output file name.');
}

async function releaseQuietly(reservation: Reservation): Promise<void> {
  await fs.unlink(reservation.path).catch(() => undefined);
}

/** Moves `source` into place: rename when possible, otherwise copy (different drive) and delete. */
async function moveFile(source: string, destination: string): Promise<void> {
  try {
    await fs.rename(source, destination);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
    await fs.copyFile(source, destination, fsc.COPYFILE_EXCL);
    await fs.unlink(source).catch(() => undefined);
  }
}

async function ensureWritableDirectory(directory: string): Promise<void> {
  try {
    await fs.mkdir(directory, { recursive: true });
    await fs.access(directory, fsc.W_OK);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') {
      throw new MorphError('PERMISSION_DENIED', 'Morph cannot save files in that folder. Choose another output folder in Settings.', { detail: directory });
    }
    throw error;
  }
}

export interface FinalizeArgs {
  result: EngineResult;
  sourcePath: string;
  baseName: string;
  workDir: string;
  settings: OutputSettings;
  signal: AbortSignal;
}

/**
 * Publishes finished work files into the destination folder.
 *
 * Order of operations (this is what guarantees "no partial or overwritten output"):
 *   1. verify the folder is writable and has room
 *   2. build the ZIP (if any) inside the private work directory
 *   3. reserve the final name exclusively
 *   4. place the data next to the final name under a temporary name, then rename over the reservation
 */
export async function finalizeOutputs(args: FinalizeArgs): Promise<JobOutput[]> {
  const { result, settings, signal } = args;
  if (result.files.length === 0) throw new MorphError('INTERNAL', 'The conversion produced no output.');
  const directory = resolveOutputDirectory(args.sourcePath, settings);
  await ensureWritableDirectory(directory);

  let finalFile: WorkFile;
  let finalName: string;
  if (result.packaging === 'zip') {
    const zipPath = path.join(args.workDir, `bundle-${randomBytes(4).toString('hex')}.zip`);
    await createZip(result.files, zipPath, { compress: false, signal });
    finalFile = { path: zipPath, name: 'bundle.zip' };
    finalName = outputFileName(args.baseName, 'zip', settings);
  } else {
    const only = result.files[0];
    if (!only) throw new MorphError('INTERNAL', 'The conversion produced no output.');
    finalFile = only;
    const extension = path.extname(only.name).replace(/^\./, '') || 'bin';
    finalName = outputFileName(path.basename(only.name, path.extname(only.name)), extension, settings);
  }

  const size = (await fs.stat(finalFile.path)).size;
  if (size === 0) throw new MorphError('TOOL_FAILED', 'The conversion produced an empty file.');
  const free = await freeBytes(directory);
  if (free !== null && free < size + SPACE_MARGIN_BYTES) {
    throw new MorphError('DISK_FULL', 'There is not enough free disk space to save the result.', { detail: `${size} bytes needed, ${free} available in ${directory}` });
  }
  if (signal.aborted) throw cancelledError();

  const reservation = await reserveOutputName(directory, finalName);
  const partial = path.join(directory, `.${reservation.name}.${randomBytes(4).toString('hex')}.morph-partial`);
  try {
    await moveFile(finalFile.path, partial);
    if (signal.aborted) throw cancelledError();
    // Replaces only our own empty placeholder, never a user file.
    await fs.rename(partial, reservation.path);
  } catch (error) {
    await fs.unlink(partial).catch(() => undefined);
    await releaseQuietly(reservation);
    throw error;
  }

  const finalSize = (await fs.stat(reservation.path)).size;
  if (finalSize !== size) {
    await releaseQuietly(reservation);
    throw new MorphError('INTERNAL', 'The saved file does not match the converted data.', { detail: `${finalSize} != ${size}` });
  }
  return [{ path: reservation.path, name: reservation.name, size: finalSize }];
}
