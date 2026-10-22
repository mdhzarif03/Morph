import yauzl from 'yauzl';
import { MorphError } from '../../../shared/errors';

export interface ZipLimits {
  maxEntries: number;
  maxTotalUncompressed: number;
  maxEntryUncompressed: number;
}

export const DOCUMENT_ZIP_LIMITS: ZipLimits = {
  maxEntries: 20_000,
  maxTotalUncompressed: 1024 * 1024 * 1024,
  maxEntryUncompressed: 512 * 1024 * 1024,
};

/**
 * Reads only the ZIP directory and refuses archives that declare an absurd amount of data
 * (decompression bombs), too many entries, or paths that try to leave the archive.
 */
export function assertSafeZip(filePath: string, limits: ZipLimits = DOCUMENT_ZIP_LIMITS): Promise<void> {
  return new Promise((resolve, reject) => {
    yauzl.open(filePath, { lazyEntries: true, autoClose: true, strictFileNames: false }, (openError: Error | null, zip: yauzl.ZipFile | undefined) => {
      if (openError || !zip) {
        reject(new MorphError('CORRUPT_INPUT', 'The document is damaged or is not a valid document file.', { detail: openError?.message ?? 'unreadable archive' }));
        return;
      }
      let entries = 0;
      let total = 0;
      const fail = (message: string) => {
        zip.close();
        reject(new MorphError('CORRUPT_INPUT', message));
      };
      zip.on('error', (error: Error) => reject(new MorphError('CORRUPT_INPUT', 'The document is damaged or is not a valid document file.', { detail: error.message })));
      zip.on('end', () => resolve());
      zip.on('entry', (entry: yauzl.Entry) => {
        entries += 1;
        total += entry.uncompressedSize;
        if (entries > limits.maxEntries) return fail('The document contains an unreasonable number of parts and was not opened.');
        if (entry.uncompressedSize > limits.maxEntryUncompressed || total > limits.maxTotalUncompressed) return fail('The document would expand to an unreasonable size and was not opened.');
        if (/(^|[\\/])\.\.([\\/]|$)/.test(entry.fileName) || entry.fileName.startsWith('/')) return fail('The document contains an unsafe file path and was not opened.');
        zip.readEntry();
      });
      zip.readEntry();
    });
  });
}

/** Reads one entry fully into memory (bounded by `maxBytes`). Returns null when the entry does not exist. */
export function readZipEntry(filePath: string, name: string, maxBytes: number): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    yauzl.open(filePath, { lazyEntries: true, autoClose: true }, (openError: Error | null, zip: yauzl.ZipFile | undefined) => {
      if (openError || !zip) {
        reject(new MorphError('CORRUPT_INPUT', 'The document is damaged or is not a valid document file.', { detail: openError?.message ?? 'unreadable archive' }));
        return;
      }
      let found = false;
      zip.on('error', (error: Error) => reject(new MorphError('CORRUPT_INPUT', 'The document is damaged.', { detail: error.message })));
      zip.on('end', () => {
        if (!found) resolve(null);
      });
      zip.on('entry', (entry: yauzl.Entry) => {
        if (entry.fileName !== name) {
          zip.readEntry();
          return;
        }
        found = true;
        if (entry.uncompressedSize > maxBytes) {
          zip.close();
          reject(new MorphError('INPUT_TOO_LARGE', 'A part of the document is too large to process.'));
          return;
        }
        zip.openReadStream(entry, (streamError: Error | null, stream: NodeJS.ReadableStream | undefined) => {
          if (streamError || !stream) {
            reject(new MorphError('CORRUPT_INPUT', 'The document is damaged.', { detail: streamError?.message ?? 'unreadable entry' }));
            return;
          }
          const chunks: Buffer[] = [];
          let size = 0;
          stream.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > maxBytes) {
              (stream as unknown as { destroy(): void }).destroy();
              zip.close();
              reject(new MorphError('INPUT_TOO_LARGE', 'A part of the document is too large to process.'));
              return;
            }
            chunks.push(chunk);
          });
          stream.on('end', () => {
            zip.close();
            resolve(Buffer.concat(chunks));
          });
          stream.on('error', (error: Error) => reject(new MorphError('CORRUPT_INPUT', 'The document is damaged.', { detail: error.message })));
        });
      });
      zip.readEntry();
    });
  });
}
