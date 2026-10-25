import { describe, expect, it } from 'vitest';
import { schemas } from '../../src/shared/ipc';
import { compactPages, parseRangeGroups } from '../../src/core/engines/pdf-tools';

describe('PDF tool requests', () => {
  it('accepts a merge of two files and a split with a range text', () => {
    expect(schemas.startPdfTool.safeParse({ kind: 'merge', items: [{ fileId: 'a1' }, { fileId: 'b2', pages: [1, 3] }] }).success).toBe(true);
    expect(schemas.startPdfTool.safeParse({ kind: 'split', item: { fileId: 'a1' }, mode: 'ranges', ranges: '1-3, 5' }).success).toBe(true);
  });

  it('rejects hostile or malformed requests', () => {
    expect(schemas.startPdfTool.safeParse({ kind: 'merge', items: [{ fileId: 'a1' }] }).success).toBe(false); // needs two
    expect(schemas.startPdfTool.safeParse({ kind: 'merge', items: [{ fileId: '../x' }, { fileId: 'b' }] }).success).toBe(false);
    expect(schemas.startPdfTool.safeParse({ kind: 'split', item: { fileId: 'a1' }, mode: 'ranges', ranges: '1; rm -rf' }).success).toBe(false);
    expect(schemas.startPdfTool.safeParse({ kind: 'split', item: { fileId: 'a1', path: 'C:/x.pdf' }, mode: 'each' }).success).toBe(false); // no raw paths
    expect(schemas.pdfPreview.safeParse({ fileId: 'a1', start: 0, count: 500 }).success).toBe(false);
  });

  it('turns typed ranges into one page list per group', () => {
    expect(parseRangeGroups('1-2, 4, 6-', 8)).toEqual([[1, 2], [4], [6, 7, 8]]);
    expect(() => parseRangeGroups('  ', 8)).toThrow(/page ranges/);
    expect(() => parseRangeGroups('9', 8)).toThrow(/only 8 pages/);
  });

  it('labels page lists compactly for file names', () => {
    expect(compactPages([3, 1, 2, 7, 9, 10])).toBe('1-3_7_9-10');
  });
});
