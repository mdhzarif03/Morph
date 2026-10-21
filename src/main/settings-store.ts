import { promises as fs } from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { DEFAULT_SETTINGS, SettingsSchema, type Settings, type SettingsPatch } from '../shared/settings';
import type { ToolId } from '../shared/types';
import type { Logger } from '../core/logger';

/**
 * Persists user settings as JSON in the app data folder. Writes are atomic (temp file + rename), a
 * damaged file is set aside rather than lost, and every value is validated on load.
 */
export class SettingsStore extends EventEmitter<{ changed: [Settings] }> {
  private current: Settings = DEFAULT_SETTINGS;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(
    private readonly file: string,
    private readonly log: Logger,
  ) {
    super();
  }

  async load(): Promise<Settings> {
    let raw: string;
    try {
      raw = await fs.readFile(this.file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.log.warn('settings unreadable', { error: String(error) });
      this.current = DEFAULT_SETTINGS;
      return this.current;
    }
    try {
      const parsed = SettingsSchema.safeParse(JSON.parse(raw));
      if (parsed.success) {
        this.current = parsed.data;
        return this.current;
      }
      this.log.warn('settings invalid, falling back to defaults', { issues: parsed.error.issues.length });
    } catch (error) {
      this.log.warn('settings corrupt', { error: String(error) });
    }
    await fs.rename(this.file, `${this.file}.corrupt-${Date.now()}`).catch(() => undefined);
    this.current = DEFAULT_SETTINGS;
    return this.current;
  }

  get(): Settings {
    return this.current;
  }

  /** Applies a validated partial update (nested objects are merged). */
  async update(patch: SettingsPatch): Promise<Settings> {
    const next: Settings = {
      ...this.current,
      ...stripUndefined(patch),
      imageQuality: { ...this.current.imageQuality, ...stripUndefined(patch.imageQuality ?? {}) },
    };
    return this.commit(next);
  }

  async setShortcut(accelerator: string): Promise<Settings> {
    return this.commit({ ...this.current, shortcut: accelerator });
  }

  async setOutputDirectory(directory: string | null): Promise<Settings> {
    return this.commit({ ...this.current, outputDirectory: directory });
  }

  async setToolPath(tool: ToolId, toolPath: string | null): Promise<Settings> {
    const toolPaths = { ...this.current.toolPaths };
    if (toolPath === null) delete toolPaths[tool];
    else toolPaths[tool] = toolPath;
    return this.commit({ ...this.current, toolPaths });
  }

  private async commit(next: Settings): Promise<Settings> {
    const validated = SettingsSchema.parse(next);
    this.current = validated;
    this.emit('changed', validated);
    await this.persist(validated);
    return validated;
  }

  private persist(settings: Settings): Promise<void> {
    this.writeChain = this.writeChain.then(async () => {
      try {
        await fs.mkdir(path.dirname(this.file), { recursive: true });
        const temp = `${this.file}.tmp`;
        await fs.writeFile(temp, JSON.stringify(settings, null, 2), 'utf8');
        await fs.rename(temp, this.file);
      } catch (error) {
        this.log.error('could not save settings', { error: String(error) });
      }
    });
    return this.writeChain;
  }
}

function stripUndefined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;
}
