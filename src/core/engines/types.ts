import type { FormatId } from '../../shared/formats';
import type { OptionValues } from '../../shared/options';
import type { ToolchainSnapshot } from '../../shared/types';
import type { Logger } from '../logger';

export interface ProgressUpdate {
  /** 0..1 or null for "unknown". */
  progress?: number | null;
  phase?: string;
}

export interface EngineContext {
  jobId: string;
  /** Resolved real path of the source. Engines only ever read it. */
  sourcePath: string;
  sourceFormat: FormatId;
  targetFormat: FormatId;
  /** Already validated by `normalizeOptions`. */
  options: OptionValues;
  /** Private temp directory. Everything an engine writes goes here. */
  workDir: string;
  /** Source file name without extension; used to name page images. */
  baseName: string;
  toolchain: ToolchainSnapshot;
  signal: AbortSignal;
  report(update: ProgressUpdate): void;
  warn(message: string): void;
  log: Logger;
}

export interface WorkFile {
  /** Absolute path inside `workDir`. */
  path: string;
  /** Final file name (no directory). */
  name: string;
}

export interface EngineResult {
  files: WorkFile[];
  /**
   * 'single': exactly one file is delivered as-is.
   * 'zip': the files are packaged, in order, into `<name>.zip` by the output stage.
   */
  packaging: 'single' | 'zip';
}

export const MAX_INPUT_PIXELS = 100_000_000;
export const MAX_ANIMATED_PIXELS = 64_000_000;
