import { validateAccelerator } from '../shared/accelerator';
import type { ShortcutResult, ShortcutStatus } from '../shared/types';
import type { Logger } from '../core/logger';

/** The part of Electron's `globalShortcut` Morph uses, so behaviour can be tested with a fake. */
export interface GlobalShortcutLike {
  register(accelerator: string, callback: () => void): boolean;
  unregister(accelerator: string): void;
  isRegistered(accelerator: string): boolean;
}

/**
 * Owns the single global shortcut. A new shortcut is registered *before* the old one is released,
 * so a failed change (conflict, invalid combination) never leaves the user without a working shortcut.
 */
export class ShortcutManager {
  private active: string | null = null;
  private problem: string | undefined;
  private wanted: string;

  constructor(
    private readonly api: GlobalShortcutLike,
    private readonly onTrigger: () => void,
    initial: string,
    private readonly log: Logger,
  ) {
    this.wanted = initial;
  }

  status(): ShortcutStatus {
    const status: ShortcutStatus = { accelerator: this.active ?? this.wanted, registered: this.active !== null };
    if (this.problem) status.problem = this.problem;
    return status;
  }

  /** Registers the configured shortcut at startup. Never throws; problems are reported via status(). */
  start(): ShortcutStatus {
    const result = this.set(this.wanted);
    return result.status;
  }

  set(accelerator: string): ShortcutResult {
    const check = validateAccelerator(accelerator);
    if (!check.ok) return { ok: false, reason: 'invalid', message: check.message, status: this.status() };

    const next = check.normalized;
    if (this.active === next && this.api.isRegistered(next)) {
      this.problem = undefined;
      return { ok: true, status: this.status() };
    }

    let registered: boolean;
    try {
      registered = this.api.register(next, this.onTrigger);
    } catch (error) {
      this.log.warn('shortcut registration threw', { accelerator: next, error: String(error) });
      this.problem = 'This key combination is not accepted by the operating system.';
      return { ok: false, reason: 'failed', message: this.problem, status: this.status() };
    }

    if (!registered || !this.api.isRegistered(next)) {
      const message = `${check.display} is already used by another application or by Windows. Choose a different shortcut.`;
      this.problem = this.active === null ? message : undefined;
      if (this.active === null) this.wanted = next;
      this.log.warn('shortcut in use', { accelerator: next });
      return { ok: false, reason: 'in-use', message, status: this.status() };
    }

    if (this.active !== null && this.active !== next) this.api.unregister(this.active);
    this.active = next;
    this.wanted = next;
    this.problem = undefined;
    this.log.info('shortcut registered', { accelerator: next });
    return { ok: true, status: this.status() };
  }

  dispose(): void {
    if (this.active !== null) this.api.unregister(this.active);
    this.active = null;
  }
}
