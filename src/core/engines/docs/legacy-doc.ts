import WordExtractor from 'word-extractor';
import { MorphError } from '../../../shared/errors';
import { escapeHtml } from './html';

/**
 * Legacy Word 97-2003 files: only the text can be recovered. Formatting, tables and pictures are
 * not available through this reader, and the caller tells the user so.
 */
export async function legacyDocToHtml(filePath: string): Promise<string> {
  let body: string;
  try {
    const document = await new WordExtractor().extract(filePath);
    body = document.getBody();
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    if (/encrypt|password/i.test(text)) throw new MorphError('PASSWORD_PROTECTED', 'This document is password-protected. Remove the password and try again.', { detail: text });
    throw new MorphError('CORRUPT_INPUT', 'The DOC file could not be opened. It may be damaged or in an unsupported variant.', { detail: text });
  }
  const paragraphs = body.split(/\r\n|\r|\n/);
  return paragraphs.map((p) => (p.trim() === '' ? '<p>&nbsp;</p>' : `<p>${escapeHtml(p).replace(/\t/g, '&emsp;')}</p>`)).join('\n');
}
