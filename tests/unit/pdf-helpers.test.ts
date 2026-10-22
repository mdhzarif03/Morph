import { describe, expect, it } from 'vitest';
import { pageLabel, parsePageRange } from '../../src/core/engines/pdf';

describe('page ranges', () => {
  it('parses lists, ranges and open ends', () => {
    expect(parsePageRange('', 4)).toEqual([1, 2, 3, 4]);
    expect(parsePageRange('1-3, 5', 10)).toEqual([1, 2, 3, 5]);
    expect(parsePageRange('8-', 10)).toEqual([8, 9, 10]);
    expect(parsePageRange('-3', 10)).toEqual([1, 2, 3]);
    expect(parsePageRange('5,1,5,2-3', 10)).toEqual([1, 2, 3, 5]);
    expect(parsePageRange('2-99', 4)).toEqual([2, 3, 4]);
  });
  it('rejects malformed, backwards and out-of-range input', () => {
    for (const bad of ['abc', '3-1', '0', '0-2', '9', '1;2', '--', '1-2-3', '-']) {
      expect(() => parsePageRange(bad, 5), bad).toThrowError(expect.objectContaining({ code: 'INVALID_OPTIONS' }));
    }
  });
  it('pads page numbers to at least three digits', () => {
    expect(pageLabel(7, 12)).toBe('007');
    expect(pageLabel(7, 1500)).toBe('0007');
  });
});
