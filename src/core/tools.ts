import { promises as fs, constants as fsc } from 'node:fs';
import path from 'node:path';
import { runProcess } from './proc';
import { MorphError } from '../shared/errors';
import type { ToolId, ToolPaths, ToolSource, ToolStatus, ToolchainSnapshot } from '../shared/types';

/**
 * Locating external tools. Resolution order (first hit wins):
 *   1. an explicit path chosen by the user in Settings
 *   2. a binary bundled with the application (`<root>/<tool dir>/…`)
 *   3. an npm-provided binary (ffmpeg-static, @ffprobe-installer/ffprobe) supplied by the host
 *   4. well-known install locations
 *   5. the PATH
 *
 * Nothing is ever downloaded or executed silently; missing tools are reported with install hints.
 */

export interface LocatorOptions {
  overrides?: ToolPaths;
  /** Directories that contain bundled tool folders (`ffmpeg/`). */
  bundledRoots?: string[];
  /** Hooks for npm-supplied binaries. Return undefined when not installed. */
  npmResolvers?: Partial<Record<ToolId, () => string | undefined>>;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
}

const TOOL_META: Record<ToolId, { label: string; neededFor: string; installHint: (platform: NodeJS.Platform) => string }> = {
  ffmpeg: {
    label: 'FFmpeg',
    neededFor: 'Audio and video conversion',
    installHint: (p) =>
      p === 'win32'
        ? 'Install with “winget install Gyan.FFmpeg”, or choose ffmpeg.exe manually below.'
        : 'Install FFmpeg with your package manager, or choose the executable manually below.',
  },
  ffprobe: {
    label: 'FFprobe',
    neededFor: 'Reading audio and video details (installed together with FFmpeg)',
    installHint: (p) =>
      p === 'win32' ? 'Installed with FFmpeg (“winget install Gyan.FFmpeg”), or choose ffprobe.exe manually below.' : 'Installed together with FFmpeg.',
  },
};

export const ALL_TOOLS: readonly ToolId[] = ['ffmpeg', 'ffprobe'];

function exeName(id: ToolId, platform: NodeJS.Platform): string {
  return platform === 'win32' ? `${id}.exe` : id;
}

async function isExecutableFile(p: string, platform: NodeJS.Platform): Promise<boolean> {
  try {
    const stat = await fs.stat(p);
    if (!stat.isFile()) return false;
    if (platform !== 'win32') await fs.access(p, fsc.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function findInPath(id: ToolId, platform: NodeJS.Platform, env: NodeJS.ProcessEnv): Promise<string | null> {
  const pathVar = env.PATH ?? env.Path ?? '';
  for (const dir of pathVar.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir.replace(/^"|"$/g, ''), exeName(id, platform));
    if (await isExecutableFile(candidate, platform)) return candidate;
  }
  return null;
}

function knownLocations(id: ToolId, platform: NodeJS.Platform): string[] {
  return platform === 'darwin' ? [`/opt/homebrew/bin/${id}`, `/usr/local/bin/${id}`] : [];
}

async function findBundled(id: ToolId, roots: string[], platform: NodeJS.Platform): Promise<string | null> {
  const exe = exeName(id, platform);
  for (const root of roots) {
    const direct: string[] = [];
    if (id === 'ffmpeg' || id === 'ffprobe') direct.push(path.join(root, 'ffmpeg', exe), path.join(root, 'ffmpeg', 'bin', exe));
    for (const candidate of direct) if (await isExecutableFile(candidate, platform)) return candidate;
  }
  return null;
}

export interface LocatedTool {
  path: string;
  source: ToolSource;
}

export async function locateTool(id: ToolId, options: LocatorOptions = {}): Promise<LocatedTool | null> {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;

  const override = options.overrides?.[id];
  if (override && (await isExecutableFile(override, platform))) return { path: override, source: 'settings' };

  const bundled = await findBundled(id, options.bundledRoots ?? [], platform);
  if (bundled) return { path: bundled, source: 'bundled' };

  const npmPath = options.npmResolvers?.[id]?.();
  if (npmPath && (await isExecutableFile(npmPath, platform))) return { path: npmPath, source: 'npm' };

  for (const candidate of knownLocations(id, platform)) {
    if (await isExecutableFile(candidate, platform)) return { path: candidate, source: 'known-location' };
  }

  const onPath = await findInPath(id, platform, env);
  if (onPath) return { path: onPath, source: 'system-path' };
  return null;
}

// ---------------------------------------------------------------------------------------------
// Versions and capabilities

const ENCODERS_OF_INTEREST = [
  'libmp3lame', 'libvorbis', 'vorbis', 'libopus', 'aac', 'flac', 'ac3', 'pcm_s16le', 'pcm_s24le',
  'libx264', 'libx265', 'libvpx-vp9', 'libvpx', 'libaom-av1', 'libsvtav1', 'mpeg4', 'mjpeg', 'libopenh264',
];

/** Extracts a short, readable version from a tool's `-version` output. Exported for tests. */
export function parseVersion(id: ToolId, output: string): string | undefined {
  const first = output.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0);
  if (!first) return undefined;
  if (id === 'ffmpeg' || id === 'ffprobe') {
    // "ffmpeg version 7.0.2-static https://…" or "ffprobe version N-66595-gc2b38619c0-static …"
    const token = /version\s+(\S+)/i.exec(first)?.[1];
    return token ? token.slice(0, 28) : undefined;
  }
  const semver = /(\d+(?:\.\d+){1,3})/.exec(first)?.[1];
  return semver ?? first.slice(0, 40);
}

async function readVersion(id: ToolId, toolPath: string): Promise<string | undefined> {
  const args = ['-version'];
  try {
    const result = await runProcess(toolPath, args, { timeoutMs: 20_000 });
    const text = `${result.stdout}\n${result.stderr}`;
    return parseVersion(id, text);
  } catch {
    return undefined;
  }
}

export async function readFfmpegEncoders(ffmpegPath: string): Promise<string[]> {
  try {
    const result = await runProcess(ffmpegPath, ['-hide_banner', '-encoders'], { timeoutMs: 20_000, maxCaptureBytes: 2_000_000 });
    const found = new Set<string>();
    for (const line of result.stdout.split(/\r?\n/)) {
      const match = /^\s*[VAS][A-Z.]{5}\s+(\S+)/.exec(line);
      if (match?.[1] && ENCODERS_OF_INTEREST.includes(match[1])) found.add(match[1]);
    }
    return [...found].sort();
  } catch {
    return [];
  }
}

export async function probeToolchain(options: LocatorOptions = {}): Promise<ToolchainSnapshot> {
  const platform = options.platform ?? process.platform;
  const entries = await Promise.all(
    ALL_TOOLS.map(async (id): Promise<[ToolId, ToolStatus]> => {
      const meta = TOOL_META[id];
      const located = await locateTool(id, options);
      const base: ToolStatus = {
        id,
        label: meta.label,
        found: located !== null,
        neededFor: meta.neededFor,
        installHint: meta.installHint(platform),
      };
      if (!located) return [id, base];
      const status: ToolStatus = { ...base, path: located.path, source: located.source };
      const version = await readVersion(id, located.path);
      if (version) status.version = version;
      if (id === 'ffmpeg') status.encoders = await readFfmpegEncoders(located.path);
      return [id, status];
    }),
  );
  return { tools: Object.fromEntries(entries) as Record<ToolId, ToolStatus>, checkedAt: Date.now() };
}

export function toolPath(snapshot: ToolchainSnapshot, id: ToolId): string | undefined {
  const status = snapshot.tools[id];
  return status.found ? status.path : undefined;
}

export function requireToolPath(snapshot: ToolchainSnapshot, id: ToolId, purpose: string): string {
  const found = toolPath(snapshot, id);
  if (found) return found;
  const meta = TOOL_META[id];
  throw new MorphError('TOOL_MISSING', `${meta.label} is required for ${purpose}, but it was not found.`, {
    detail: snapshot.tools[id].installHint,
  });
}
