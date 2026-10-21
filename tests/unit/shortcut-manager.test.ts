import { describe, expect, it } from 'vitest';
import { ShortcutManager, type GlobalShortcutLike } from '../../src/main/shortcut-manager';
import { noopLogger } from '../../src/core/logger';

class FakeShortcuts implements GlobalShortcutLike {
  taken = new Set<string>();
  mine = new Map<string, () => void>();
  throwOn: string | null = null;
  register(acc: string, cb: () => void): boolean {
    if (this.throwOn === acc) throw new Error('bad accelerator');
    if (this.taken.has(acc) || this.mine.has(acc)) return false;
    this.mine.set(acc, cb);
    return true;
  }
  unregister(acc: string): void {
    this.mine.delete(acc);
  }
  isRegistered(acc: string): boolean {
    return this.mine.has(acc);
  }
}

function make(initial = 'Ctrl+Shift+C') {
  const api = new FakeShortcuts();
  let fired = 0;
  const mgr = new ShortcutManager(api, () => (fired += 1), initial, noopLogger);
  return { api, mgr, fired: () => fired };
}

describe('ShortcutManager', () => {
  it('registers the default and triggers the callback', () => {
    const { api, mgr, fired } = make();
    expect(mgr.start()).toMatchObject({ registered: true });
    api.mine.get('Ctrl+Shift+C')?.();
    expect(fired()).toBe(1);
  });

  it('reports a conflict at startup without throwing', () => {
    const { api, mgr } = make();
    api.taken.add('Ctrl+Shift+C');
    const status = mgr.start();
    expect(status.registered).toBe(false);
    expect(status.problem).toMatch(/already used/);
  });

  it('rejects unsafe shortcuts and keeps the current one working', () => {
    const { api, mgr } = make();
    mgr.start();
    for (const bad of ['Shift+C', 'C', 'Shift']) {
      const r = mgr.set(bad);
      expect(r.ok, bad).toBe(false);
      if (!r.ok) expect(r.reason).toBe('invalid');
    }
    expect(api.isRegistered('Ctrl+Shift+C')).toBe(true);
    expect(mgr.status().registered).toBe(true);
  });

  it('swaps shortcuts atomically and keeps the old one when the new one is taken', () => {
    const { api, mgr } = make();
    mgr.start();
    api.taken.add('Ctrl+Alt+K');
    const failed = mgr.set('Ctrl+Alt+K');
    expect(failed.ok).toBe(false);
    if (!failed.ok) expect(failed.reason).toBe('in-use');
    expect(api.isRegistered('Ctrl+Shift+C')).toBe(true);
    expect(mgr.status()).toMatchObject({ accelerator: 'Ctrl+Shift+C', registered: true });

    const ok = mgr.set('Ctrl+Alt+M');
    expect(ok.ok).toBe(true);
    expect(api.isRegistered('Ctrl+Shift+C')).toBe(false);
    expect(api.isRegistered('Ctrl+Alt+M')).toBe(true);
  });

  it('survives the OS throwing on registration', () => {
    const { api, mgr } = make();
    mgr.start();
    api.throwOn = 'Ctrl+Alt+Q';
    const r = mgr.set('Ctrl+Alt+Q');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('failed');
    expect(api.isRegistered('Ctrl+Shift+C')).toBe(true);
  });

  it('dispose releases the shortcut', () => {
    const { api, mgr } = make();
    mgr.start();
    mgr.dispose();
    expect(api.mine.size).toBe(0);
  });
});
