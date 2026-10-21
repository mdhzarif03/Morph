import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import yazl from 'yazl';
import { cancelledError } from '../shared/errors';
import { safeEntryName } from './fsutil';

export interface ZipEntry {
  /** File on disk to add. It is streamed, never loaded fully into memory. */
  path: string;
  /** Name inside the archive. Reduced to a plain, safe file name. */
  name: string;
}

/**
 * Writes a ZIP archive. Entries are stored in the given order, names can never contain path
 * separators or `..`, and duplicate names are disambiguated deterministically.
 */
export async function createZip(entries: readonly ZipEntry[], destination: string, options: { compress?: boolean; signal?: AbortSignal } = {}): Promise<string[]> {
  const { compress = false, signal } = options;
  if (signal?.aborted) throw cancelledError();

  const zip = new yazl.ZipFile();
  const used = new Set<string>();
  const written: string[] = [];

  for (const entry of entries) {
    let name = safeEntryName(entry.name);
    if (used.has(name.toLowerCase())) {
      const dot = name.lastIndexOf('.');
      const stem = dot > 0 ? name.slice(0, dot) : name;
      const ext = dot > 0 ? name.slice(dot) : '';
      let n = 1;
      while (used.has(`${stem} (${n})${ext}`.toLowerCase())) n += 1;
      name = `${stem} (${n})${ext}`;
    }
    used.add(name.toLowerCase());
    written.push(name);
    zip.addFile(entry.path, name, { compress });
  }
  zip.end();

  const out = createWriteStream(destination, { flags: 'wx' });
  await pipeline(zip.outputStream, out, signal ? { signal } : {});
  return written;
}
