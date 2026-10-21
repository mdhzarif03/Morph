import yauzl from 'yauzl';

export interface ZipListing {
  names: string[];
  /** First 4 bytes of each entry, hex-encoded, in archive order. */
  magic: string[];
  sizes: number[];
}

/** Reads entry names, sizes and magic bytes of a ZIP in archive order. */
export function readZip(file: string): Promise<ZipListing> {
  return new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true }, (error, zip) => {
      if (error || !zip) {
        reject(error ?? new Error('cannot open zip'));
        return;
      }
      const listing: ZipListing = { names: [], magic: [], sizes: [] };
      zip.on('error', reject);
      zip.on('end', () => resolve(listing));
      zip.on('entry', (entry: yauzl.Entry) => {
        listing.names.push(entry.fileName);
        listing.sizes.push(entry.uncompressedSize);
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) {
            reject(streamError ?? new Error('cannot read entry'));
            return;
          }
          const chunks: Buffer[] = [];
          stream.on('data', (c: Buffer) => chunks.push(c));
          stream.on('end', () => {
            listing.magic.push(Buffer.concat(chunks).subarray(0, 4).toString('hex'));
            zip.readEntry();
          });
        });
      });
      zip.readEntry();
    });
  });
}
