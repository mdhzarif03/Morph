import { promises as fs } from 'node:fs';
import { MorphError } from '../../../shared/errors';
import { escapeHtml } from './html';

const MAX_TEXT_BYTES = 100 * 1024 * 1024;

export function decodeText(raw: Buffer): string {
  let text: string;
  if (raw[0] === 0xff && raw[1] === 0xfe) text = new TextDecoder('utf-16le').decode(raw.subarray(2));
  else if (raw[0] === 0xfe && raw[1] === 0xff) text = new TextDecoder('utf-16be').decode(raw.subarray(2));
  else {
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(raw);
    } catch {
      text = new TextDecoder('windows-1252').decode(raw);
    }
  }
  return text.replace(/^\uFEFF/, '');
}

export async function txtToHtml(filePath: string): Promise<string> {
  const stat = await fs.stat(filePath);
  if (stat.size > MAX_TEXT_BYTES) throw new MorphError('INPUT_TOO_LARGE', 'This text file is too large to convert to a document (limit 100 MB).');
  const text = decodeText(await fs.readFile(filePath));
  return `<pre class="plain">${escapeHtml(text.replace(/\r\n?/g, '\n'))}</pre>`;
}
