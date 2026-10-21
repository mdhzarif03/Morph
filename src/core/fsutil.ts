import { promises as fs, constants as fsc } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MorphError } from '../shared/errors';

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/** Makes a string safe to use as a single file name on Windows, macOS and Linux. */
export function sanitizeFileName(name: string, fallback = 'file'): string {
  // eslint-disable-next-line no-control-regex
  let out = name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').normalize('NFC');
  out = out.replace(/[. ]+$/, '').replace(/^\s+/, '');
  if (out === '' || out === '.' || out === '..') out = fallback;
  if (WINDOWS_RESERVED.test(out)) out = `_${out}`;
  return out.length > 200 ? out.slice(0, 200) : out;
}

/** A name for an entry inside a ZIP/folder we create. Never contains separators or traversal. */
export function safeEntryName(name: string): string {
  const base = path.basename(name.replace(/\\/g, '/'));
  return sanitizeFileName(base, 'file');
}

/** True when `child` is `parent` itself or lies inside it (after normalisation). */
export function isInside(parent: string, child: string): boolean {
  const resolvedParent = path.resolve(parent);
  const resolvedChild = path.resolve(child);
  const a = process.platform === 'win32' ? resolvedParent.toLowerCase() : resolvedParent;
  const b = process.platform === 'win32' ? resolvedChild.toLowerCase() : resolvedChild;
  const rel = path.relative(a, b);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

export interface SourceStat {
  /** Path with symlinks resolved. Reads happen here. */
  realPath: string;
  size: number;
  mtimeMs: number;
}

/**
 * Validates that a path is an existing, non-empty, regular file and resolves symbolic links.
 * Directories, devices, pipes and sockets are refused.
 */
export async function statRegularFile(inputPath: string): Promise<SourceStat> {
  if (!path.isAbsolute(inputPath) || inputPath.includes('\0')) {
    throw new MorphError('INVALID_INPUT', 'That is not a valid file path.');
  }
  let realPath: string;
  try {
    realPath = await fs.realpath(inputPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') throw new MorphError('INVALID_INPUT', 'The file could not be found. It may have been moved or deleted.');
    if (code === 'EACCES' || code === 'EPERM') throw new MorphError('PERMISSION_DENIED', 'Morph does not have permission to read this file.');
    throw error;
  }
  const stat = await fs.stat(realPath);
  if (stat.isDirectory()) throw new MorphError('INVALID_INPUT', 'Folders cannot be converted. Drop individual files instead.');
  if (!stat.isFile()) throw new MorphError('INVALID_INPUT', 'This is not a regular file.');
  if (stat.size === 0) throw new MorphError('CORRUPT_INPUT', 'The file is empty.');
  try {
    await fs.access(realPath, fsc.R_OK);
  } catch {
    throw new MorphError('PERMISSION_DENIED', 'Morph does not have permission to read this file.');
  }
  return { realPath, size: stat.size, mtimeMs: stat.mtimeMs };
}

export async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.lstat(p);
    return true;
  } catch {
    return false;
  }
}

/** Creates a fresh private temp directory for one job. */
export async function makeWorkDir(prefix = 'morph-'): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

/** Recursively removes a directory, retrying briefly because Windows may hold handles open. */
export async function removeDir(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => undefined);
}

export async function fileSize(p: string): Promise<number> {
  return (await fs.stat(p)).size;
}

/** Free bytes on the volume holding `dir`, or null when it cannot be determined. */
export async function freeBytes(dir: string): Promise<number | null> {
  try {
    const stats = await fs.statfs(dir);
    return Number(stats.bavail) * Number(stats.bsize);
  } catch {
    return null;
  }
}

export function baseNameWithoutExtension(filePath: string): string {
  const ext = path.extname(filePath);
  return path.basename(filePath, ext);
}
