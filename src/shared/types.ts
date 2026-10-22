import type { Category, FormatId } from './formats';
import type { ErrorInfo } from './errors';
import type { OptionSpec, OptionValues } from './options';

export type ToolId = 'ffmpeg' | 'ffprobe';

export type ToolSource = 'settings' | 'bundled' | 'npm' | 'system-path' | 'known-location';

export interface ToolStatus {
  id: ToolId;
  label: string;
  found: boolean;
  path?: string;
  source?: ToolSource;
  version?: string;
  /** Names of conversions that need this tool. */
  neededFor: string;
  /** Human-readable instruction when the tool is missing. */
  installHint: string;
  /** FFmpeg only: encoders this build provides (subset Morph cares about). */
  encoders?: string[];
}

export type ToolPaths = Partial<Record<ToolId, string>>;

/** Everything the engines need to know about the environment. */
export interface ToolchainSnapshot {
  tools: Record<ToolId, ToolStatus>;
  checkedAt: number;
}

// ---------------------------------------------------------------------------------------------
// Inspection

export interface FileDetails {
  width?: number;
  height?: number;
  pages?: number;
  animated?: boolean;
  hasAlpha?: boolean;
  durationSec?: number;
  hasVideo?: boolean;
  hasAudio?: boolean;
  videoCodec?: string;
  audioCodec?: string;
}

export interface TargetDescriptor {
  format: FormatId;
  label: string;
  description: string;
  available: boolean;
  /** Present when `available` is false. */
  unavailableReason?: string;
  options: OptionSpec[];
  /** Limitations the user should know about before converting. */
  notes: string[];
}

export interface InspectedFile {
  /** Opaque handle. The renderer never needs (and cannot use) raw paths to start a conversion. */
  id: string;
  /** Shown to the user. */
  path: string;
  name: string;
  directory: string;
  size: number;
  format: FormatId;
  formatLabel: string;
  category: Category;
  /** Human description from content sniffing, e.g. "PNG image". */
  description: string;
  extensionMismatch: boolean;
  notes: string[];
  details: FileDetails;
  /** data: URL, images only. */
  preview?: string;
  targets: TargetDescriptor[];
}

export interface RejectedFile {
  name: string;
  path: string;
  error: ErrorInfo;
}

export interface InspectResult {
  files: InspectedFile[];
  rejected: RejectedFile[];
}

// ---------------------------------------------------------------------------------------------
// Jobs

export type JobStatus = 'queued' | 'running' | 'finalizing' | 'succeeded' | 'failed' | 'cancelled';

export interface JobOutput {
  path: string;
  name: string;
  size: number;
}

export interface JobSnapshot {
  id: string;
  fileId: string;
  sourcePath: string;
  sourceName: string;
  sourceFormat: FormatId;
  targetFormat: FormatId;
  options: OptionValues;
  status: JobStatus;
  /** Short label for what is happening, e.g. "Rendering page 3 of 12". */
  phase: string | null;
  /** 0..1, or null when the amount of work is unknown. */
  progress: number | null;
  outputs: JobOutput[];
  /** The file (or folder) to open / reveal. */
  primaryOutput: string | null;
  warnings: string[];
  error: ErrorInfo | null;
  cancelRequested: boolean;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
}

export interface StartConversionRequest {
  fileIds: string[];
  target: FormatId;
  options: Record<string, unknown>;
}

export interface StartConversionResponse {
  jobIds: string[];
  /** Files that could not be queued, with reasons. */
  rejected: Array<{ fileId: string; error: ErrorInfo }>;
}

// ---------------------------------------------------------------------------------------------
// Shortcut

export interface ShortcutStatus {
  accelerator: string;
  registered: boolean;
  /** Present when registration failed. */
  problem?: string;
}

export type ShortcutResult =
  | { ok: true; status: ShortcutStatus }
  | { ok: false; reason: 'invalid' | 'in-use' | 'failed'; message: string; status: ShortcutStatus };

export interface AppInfo {
  name: string;
  version: string;
  electron: string;
  chrome: string;
  node: string;
  platform: string;
  arch: string;
  isPackaged: boolean;
  userDataPath: string;
  logsPath: string;
}
