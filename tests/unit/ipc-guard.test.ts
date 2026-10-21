import { describe, expect, it } from 'vitest';
import { isTrustedSender, parsePayload } from '../../src/main/ipc-guard';
import { schemas } from '../../src/shared/ipc';

const trusted = { fileUrlPrefix: 'file:///app/dist/renderer/', devServerOrigin: 'http://localhost:5173' };

describe('IPC sender trust', () => {
  it('accepts only the top-level Morph page', () => {
    expect(isTrustedSender({ senderFrame: { url: 'file:///app/dist/renderer/index.html' } }, trusted)).toBe(true);
    expect(isTrustedSender({ senderFrame: { url: 'http://localhost:5173/' } }, trusted)).toBe(true);
    expect(isTrustedSender({ senderFrame: { url: 'http://localhost:5173/x' } }, trusted)).toBe(true);
  });
  it('rejects other origins, sub-frames and missing frames', () => {
    expect(isTrustedSender({ senderFrame: { url: 'https://evil.example/' } }, trusted)).toBe(false);
    expect(isTrustedSender({ senderFrame: { url: 'http://localhost:5173.evil.example/' } }, trusted)).toBe(false);
    expect(isTrustedSender({ senderFrame: { url: 'file:///etc/passwd' } }, trusted)).toBe(false);
    expect(isTrustedSender({ senderFrame: { url: 'file:///app/dist/renderer/index.html', parent: {} } }, trusted)).toBe(false);
    expect(isTrustedSender({ senderFrame: null }, trusted)).toBe(false);
    expect(isTrustedSender({}, trusted)).toBe(false);
  });
  it('ignores the dev origin when none is configured', () => {
    expect(isTrustedSender({ senderFrame: { url: 'http://localhost:5173/' } }, { fileUrlPrefix: trusted.fileUrlPrefix })).toBe(false);
  });
});

describe('IPC payload schemas', () => {
  it('accepts valid requests', () => {
    expect(parsePayload(schemas.startConversion, { fileIds: ['abc-123'], target: 'webp', options: { quality: 80, lossless: false } }).target).toBe('webp');
    expect(parsePayload(schemas.inspectPaths, { paths: ['/home/a/b.png'] }).paths).toHaveLength(1);
  });

  it('rejects malformed, unknown and oversized input with INVALID_INPUT', () => {
    const bad: Array<[keyof typeof schemas, unknown]> = [
      ['startConversion', { fileIds: [], target: 'png', options: {} }],
      ['startConversion', { fileIds: ['a'], target: 'exe', options: {} }],
      ['startConversion', { fileIds: ['a'], target: 'png', options: {}, extra: 1 }],
      ['startConversion', { fileIds: ['a'], target: 'png', options: { x: { nested: true } } }],
      ['startConversion', { fileIds: ['../../etc'], target: 'png', options: {} }],
      ['startConversion', { fileIds: ['a'], target: 'png', options: { q: 'x'.repeat(300) } }],
      ['inspectPaths', { paths: ['a\0b'] }],
      ['inspectPaths', { paths: Array.from({ length: 201 }, () => '/a') }],
      ['inspectPaths', { paths: [] }],
      ['jobId', { jobId: '' }],
      ['jobId', 'string'],
      ['pickToolPath', { tool: 'bash' }],
      ['setShortcut', { accelerator: '' }],
      ['setContentHeight', { height: Number.NaN }],
      ['setContentHeight', { height: 1e9 }],
      ['updateSettings', { outputDirectory: '/etc' }],
      ['updateSettings', { unknownKey: true }],
    ];
    for (const [name, payload] of bad) {
      expect(() => parsePayload(schemas[name], payload), `${name} ${JSON.stringify(payload)?.slice(0, 60)}`).toThrowError(expect.objectContaining({ code: 'INVALID_INPUT' }));
    }
  });

  it('does not let a renderer set an output directory (only null to reset)', () => {
    expect(parsePayload(schemas.updateSettings, { outputDirectory: null })).toEqual({ outputDirectory: null });
  });
});

describe('settings patches', () => {
  it('never inject defaults for fields that were not sent', () => {
    expect(parsePayload(schemas.updateSettings, { notifications: false })).toEqual({ notifications: false });
    expect(parsePayload(schemas.updateSettings, { imageQuality: { jpg: 70 } })).toEqual({ imageQuality: { jpg: 70 } });
    expect(parsePayload(schemas.updateSettings, {})).toEqual({});
  });
});
