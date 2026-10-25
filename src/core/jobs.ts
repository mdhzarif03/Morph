import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { MorphError, cancelledError, isAbortError, toErrorInfo } from '../shared/errors';
import type { FormatId } from '../shared/formats';
import type { JobSnapshot, JobStatus, StartPdfToolRequest, ToolchainSnapshot } from '../shared/types';
import type { QualityDefaults } from './engines/image';
import type { ExecRequest, Executor } from './executor';
import type { PdfToolRequest } from './engines/pdf-tools';
import { makeWorkDir, removeDir, statRegularFile } from './fsutil';
import type { FileRegistry, RegisteredFile } from './inspect';
import { noopLogger, type Logger } from './logger';
import { finalizeOutputs, type OutputSettings } from './output';
import { resolveConversion } from './registry';

export interface JobManagerDeps {
  executor: Executor;
  registry: FileRegistry;
  getToolchain(): ToolchainSnapshot;
  getOutputSettings(): OutputSettings;
  getQuality(): QualityDefaults;
  log?: Logger;
  /** Jobs that may run at the same time. Conversions are CPU heavy, so the default is small. */
  concurrency?: number;
}

interface JobRecord {
  snapshot: JobSnapshot;
  /** The first (or only) input. Outputs go next to it and are named after it. */
  file: RegisteredFile;
  /** Every input that must still be unchanged when the job starts. */
  inputs: RegisteredFile[];
  /** Output base name (without extension). */
  baseName: string;
  pdfTool?: PdfToolRequest;
  controller: AbortController;
}

const FINISHED: readonly JobStatus[] = ['succeeded', 'failed', 'cancelled'];
const PROGRESS_EMIT_INTERVAL_MS = 100;
const MAX_FINISHED_KEPT = 200;

export type JobManagerEvents = { updated: [JobSnapshot] };

/**
 * Queue and lifecycle of conversion jobs.
 *   queued -> running -> finalizing -> succeeded | failed | cancelled
 * The source file is only read. Output is produced in a private work directory and published by
 * `finalizeOutputs` after the engine has finished successfully; the work directory is always removed.
 */
export class JobManager extends EventEmitter<JobManagerEvents> {
  private readonly jobs = new Map<string, JobRecord>();
  private readonly queue: string[] = [];
  private running = 0;
  private readonly lastEmit = new Map<string, number>();
  private readonly log: Logger;
  private readonly concurrency: number;

  constructor(private readonly deps: JobManagerDeps) {
    super();
    this.log = deps.log ?? noopLogger;
    this.concurrency = Math.max(1, deps.concurrency ?? 2);
  }

  /** Validates the request and queues the job. Throws a MorphError when the request is invalid. */
  enqueue(fileId: string, target: FormatId, rawOptions: Record<string, unknown>): JobSnapshot {
    const file = this.deps.registry.get(fileId);
    if (!file) throw new MorphError('INVALID_INPUT', 'That file is no longer available. Add it again.');

    const { options } = resolveConversion(file.format, target, rawOptions, { toolchain: this.deps.getToolchain(), quality: this.deps.getQuality() });

    const id = randomUUID();
    const snapshot: JobSnapshot = {
      id,
      kind: 'convert',
      fileId,
      sourcePath: file.path,
      sourceName: file.path.split(/[\\/]/).pop() ?? file.path,
      sourceFormat: file.format,
      targetFormat: target,
      options,
      status: 'queued',
      phase: 'Waiting',
      progress: 0,
      outputs: [],
      primaryOutput: null,
      warnings: [],
      error: null,
      cancelRequested: false,
      createdAt: Date.now(),
      startedAt: null,
      finishedAt: null,
    };
    this.jobs.set(id, { snapshot, file, inputs: [file], baseName: file.baseName, controller: new AbortController() });
    this.queue.push(id);
    this.emitUpdate(snapshot, true);
    this.pump();
    return { ...snapshot };
  }

  /** Queues a PDF merge or split. Page selections are checked against the document by the engine. */
  enqueuePdfTool(request: StartPdfToolRequest): JobSnapshot {
    const lookup = (fileId: string): RegisteredFile => {
      const file = this.deps.registry.get(fileId);
      if (!file) throw new MorphError('INVALID_INPUT', 'That file is no longer available. Add it again.');
      if (file.format !== 'pdf') throw new MorphError('INVALID_INPUT', `${file.path.split(/[\\/]/).pop() ?? 'This file'} is not a PDF.`);
      return file;
    };
    const toInput = (file: RegisteredFile, pages: number[] | undefined) => ({ path: file.realPath, name: file.path.split(/[\\/]/).pop() ?? file.path, pages: pages ?? null });

    let inputs: RegisteredFile[];
    let pdfTool: PdfToolRequest;
    let title: string;
    let baseName: string;
    if (request.kind === 'merge') {
      if (request.items.length < 2) throw new MorphError('INVALID_OPTIONS', 'Add at least two PDFs to merge.');
      inputs = request.items.map((item) => lookup(item.fileId));
      pdfTool = { kind: 'merge', inputs: request.items.map((item, i) => toInput(inputs[i] as RegisteredFile, item.pages)) };
      title = `Merge ${inputs.length} PDFs`;
      baseName = `${(inputs[0] as RegisteredFile).baseName}_merged`;
    } else {
      const file = lookup(request.item.fileId);
      inputs = [file];
      pdfTool = { kind: 'split', input: toInput(file, request.item.pages), mode: request.mode, ...(request.ranges !== undefined ? { ranges: request.ranges } : {}), ...(request.every !== undefined ? { every: request.every } : {}) };
      title = request.mode === 'extract' ? `Extract pages from ${toInput(file, undefined).name}` : `Split ${toInput(file, undefined).name}`;
      baseName = file.baseName;
    }
    const first = inputs[0] as RegisteredFile;

    const id = randomUUID();
    const snapshot: JobSnapshot = {
      id,
      kind: request.kind,
      title,
      fileId: first.id,
      sourcePath: first.path,
      sourceName: first.path.split(/[\\/]/).pop() ?? first.path,
      sourceFormat: 'pdf',
      targetFormat: 'pdf',
      options: {},
      status: 'queued',
      phase: 'Waiting',
      progress: 0,
      outputs: [],
      primaryOutput: null,
      warnings: [],
      error: null,
      cancelRequested: false,
      createdAt: Date.now(),
      startedAt: null,
      finishedAt: null,
    };
    this.jobs.set(id, { snapshot, file: first, inputs, baseName, pdfTool, controller: new AbortController() });
    this.queue.push(id);
    this.emitUpdate(snapshot, true);
    this.pump();
    return { ...snapshot };
  }

  get(jobId: string): JobSnapshot | undefined {
    const record = this.jobs.get(jobId);
    return record ? { ...record.snapshot } : undefined;
  }

  list(): JobSnapshot[] {
    return [...this.jobs.values()].map((r) => ({ ...r.snapshot }));
  }

  cancel(jobId: string): void {
    const record = this.jobs.get(jobId);
    if (!record || FINISHED.includes(record.snapshot.status)) return;
    record.snapshot.cancelRequested = true;
    if (record.snapshot.status === 'queued') {
      const index = this.queue.indexOf(jobId);
      if (index >= 0) this.queue.splice(index, 1);
      this.finish(record, 'cancelled', { error: toErrorInfo(cancelledError()) });
      return;
    }
    record.snapshot.phase = 'Cancelling';
    this.emitUpdate(record.snapshot, true);
    record.controller.abort();
  }

  cancelAll(): void {
    for (const id of [...this.jobs.keys()]) this.cancel(id);
  }

  /** Removes finished jobs from the list (their output files are untouched). */
  clearFinished(): void {
    for (const [id, record] of this.jobs) {
      if (FINISHED.includes(record.snapshot.status)) {
        this.jobs.delete(id);
        this.lastEmit.delete(id);
      }
    }
  }

  hasActiveJobs(): boolean {
    return [...this.jobs.values()].some((r) => !FINISHED.includes(r.snapshot.status));
  }

  /** Resolves once the queue is empty and nothing is running. */
  async idle(): Promise<void> {
    while (this.hasActiveJobs()) await new Promise((resolve) => setTimeout(resolve, 20));
  }

  // -------------------------------------------------------------------------------------------

  private pump(): void {
    while (this.running < this.concurrency) {
      const id = this.queue.shift();
      if (id === undefined) return;
      const record = this.jobs.get(id);
      if (!record || record.snapshot.status !== 'queued') continue;
      this.running += 1;
      void this.run(record).finally(() => {
        this.running -= 1;
        this.pump();
      });
    }
  }

  private emitUpdate(snapshot: JobSnapshot, force: boolean): void {
    const now = Date.now();
    if (!force && now - (this.lastEmit.get(snapshot.id) ?? 0) < PROGRESS_EMIT_INTERVAL_MS) return;
    this.lastEmit.set(snapshot.id, now);
    this.emit('updated', { ...snapshot, outputs: [...snapshot.outputs], warnings: [...snapshot.warnings] });
  }

  private finish(record: JobRecord, status: 'succeeded' | 'failed' | 'cancelled', extra: Partial<JobSnapshot>): void {
    Object.assign(record.snapshot, extra, { status, finishedAt: Date.now(), progress: status === 'succeeded' ? 1 : record.snapshot.progress });
    record.snapshot.phase = status === 'succeeded' ? 'Done' : status === 'cancelled' ? 'Cancelled' : 'Failed';
    this.emitUpdate(record.snapshot, true);
    this.trimFinished();
  }

  private trimFinished(): void {
    const finished = [...this.jobs.entries()].filter(([, r]) => FINISHED.includes(r.snapshot.status));
    for (const [id] of finished.slice(0, Math.max(0, finished.length - MAX_FINISHED_KEPT))) this.jobs.delete(id);
  }

  private async run(record: JobRecord): Promise<void> {
    const { snapshot, file, controller, inputs, baseName, pdfTool } = record;
    const signal = controller.signal;
    let workDir: string | null = null;

    try {
      snapshot.status = 'running';
      snapshot.startedAt = Date.now();
      snapshot.phase = 'Starting';
      snapshot.progress = null;
      this.emitUpdate(snapshot, true);
      signal.throwIfAborted();

      // Every input must still be the file the user added.
      for (const input of inputs) {
        const current = await statRegularFile(input.realPath);
        if (current.size !== input.size || Math.abs(current.mtimeMs - input.mtimeMs) > 1) {
          throw new MorphError('SOURCE_CHANGED', 'A file was modified after it was added. Add it again to use the current version.');
        }
      }

      workDir = await makeWorkDir();
      const outputSettings = this.deps.getOutputSettings();

      const result = await this.deps.executor(
        {
          jobId: snapshot.id,
          sourcePath: file.realPath,
          sourceFormat: file.format,
          targetFormat: snapshot.targetFormat,
          options: snapshot.options,
          workDir,
          baseName,
          toolchain: this.deps.getToolchain(),
          ...(pdfTool ? { pdfTool } : {}),
        } satisfies ExecRequest,
        (event) => {
          if (event.type === 'warning') {
            if (!snapshot.warnings.includes(event.message)) snapshot.warnings.push(event.message);
            this.emitUpdate(snapshot, true);
            return;
          }
          if (snapshot.status !== 'running') return;
          if (event.update.phase !== undefined) snapshot.phase = event.update.phase;
          if (event.update.progress !== undefined) snapshot.progress = event.update.progress;
          this.emitUpdate(snapshot, event.update.phase !== undefined && event.update.progress === undefined);
        },
        signal,
        this.log,
      );
      signal.throwIfAborted();

      snapshot.status = 'finalizing';
      snapshot.phase = 'Saving';
      snapshot.progress = 1;
      this.emitUpdate(snapshot, true);

      const outputs = await finalizeOutputs({ result, sourcePath: file.path, baseName, workDir, settings: outputSettings, signal });
      this.finish(record, 'succeeded', { outputs, primaryOutput: outputs[0]?.path ?? null });
      this.log.info('job succeeded', { jobId: snapshot.id, source: snapshot.sourceFormat, target: snapshot.targetFormat });
    } catch (error) {
      if (isAbortError(error) || signal.aborted) {
        this.finish(record, 'cancelled', { error: toErrorInfo(cancelledError()) });
      } else {
        const info = toErrorInfo(error);
        this.log.warn('job failed', { jobId: snapshot.id, code: info.code, detail: info.detail });
        this.finish(record, 'failed', { error: info });
      }
    } finally {
      if (workDir) await removeDir(workDir);
    }
  }
}
