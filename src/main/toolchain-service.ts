import path from 'node:path';
import type { ToolId, ToolPaths, ToolchainSnapshot } from '../shared/types';
import { probeToolchain, type LocatorOptions } from '../core/tools';

// The main process is bundled as CommonJS, where `require` is available.
 
const nodeRequire: (id: string) => unknown = require;

/** In a packaged app native binaries live next to app.asar, not inside it. */
export function unpackedPath(p: string): string {
  return p.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
}

function npmBinary(moduleName: string): () => string | undefined {
  return () => {
    try {
      const value: unknown = nodeRequire(moduleName);
      const resolved =
        typeof value === 'string' ? value : value && typeof value === 'object' && 'path' in value && typeof (value).path === 'string' ? (value as { path: string }).path : undefined;
      return resolved ? unpackedPath(resolved) : undefined;
    } catch {
      return undefined;
    }
  };
}

export interface ToolchainServiceOptions {
  /** Folders holding bundled tool directories (`ffmpeg/`, `poppler/`, `libreoffice/`). */
  bundledRoots: string[];
  getOverrides(): ToolPaths;
}

/** Locates external tools once and caches the result; refreshed on demand or when settings change. */
export class ToolchainService {
  private snapshot: ToolchainSnapshot | null = null;
  private pending: Promise<ToolchainSnapshot> | null = null;

  constructor(private readonly options: ToolchainServiceOptions) {}

  private locatorOptions(): LocatorOptions {
    return {
      overrides: this.options.getOverrides(),
      bundledRoots: this.options.bundledRoots,
      npmResolvers: { ffmpeg: npmBinary('ffmpeg-static'), ffprobe: npmBinary('@ffprobe-installer/ffprobe') },
    };
  }

  async refresh(): Promise<ToolchainSnapshot> {
    this.pending ??= probeToolchain(this.locatorOptions())
      .then((snapshot) => {
        this.snapshot = snapshot;
        return snapshot;
      })
      .finally(() => {
        this.pending = null;
      });
    return this.pending;
  }

  async get(): Promise<ToolchainSnapshot> {
    return this.snapshot ?? this.refresh();
  }

  /** Synchronous access for job creation; always populated after `refresh()` has run once at startup. */
  current(): ToolchainSnapshot {
    if (!this.snapshot) throw new Error('Toolchain has not been probed yet');
    return this.snapshot;
  }

  has(tool: ToolId): boolean {
    return this.snapshot?.tools[tool].found ?? false;
  }
}

export function bundledVendorRoots(resourcesPath: string, appPath: string, isPackaged: boolean): string[] {
  return isPackaged ? [path.join(resourcesPath, 'vendor')] : [path.join(appPath, 'vendor')];
}
