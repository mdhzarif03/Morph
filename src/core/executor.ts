import type { FormatId } from '../shared/formats';
import { MorphError } from '../shared/errors';
import type { OptionValues } from '../shared/options';
import type { ToolchainSnapshot } from '../shared/types';
import type { EngineResult, ProgressUpdate } from './engines/types';
import { noopLogger, type Logger } from './logger';
import { findRoute } from './registry';

/** Everything an engine needs, as plain serialisable data (it crosses the worker boundary). */
export interface ExecRequest {
  jobId: string;
  sourcePath: string;
  sourceFormat: FormatId;
  targetFormat: FormatId;
  options: OptionValues;
  workDir: string;
  baseName: string;
  toolchain: ToolchainSnapshot;
}

export type ExecEvent = { type: 'progress'; update: ProgressUpdate } | { type: 'warning'; message: string };

export type Executor = (request: ExecRequest, onEvent: (event: ExecEvent) => void, signal: AbortSignal, log: Logger) => Promise<EngineResult>;

/** Runs the matching engine in the current thread. Used inside the worker and directly by tests. */
export const executeInProcess: Executor = async (request, onEvent, signal, log = noopLogger) => {
  const route = findRoute(request.sourceFormat, request.targetFormat);
  if (!route) throw new MorphError('UNSUPPORTED_FORMAT', 'That conversion is not supported.');
  return route.run({
    jobId: request.jobId,
    sourcePath: request.sourcePath,
    sourceFormat: request.sourceFormat,
    targetFormat: request.targetFormat,
    options: request.options,
    workDir: request.workDir,
    baseName: request.baseName,
    toolchain: request.toolchain,
    signal,
    report: (update) => onEvent({ type: 'progress', update }),
    warn: (message) => onEvent({ type: 'warning', message }),
    log,
  });
};
