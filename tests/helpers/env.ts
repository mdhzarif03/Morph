import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { afterAll } from 'vitest';
import type { InspectedFile, JobSnapshot, StartPdfToolRequest, ToolchainSnapshot } from '../../src/shared/types';
import type { FormatId } from '../../src/shared/formats';
import { executeInProcess } from '../../src/core/executor';
import { FileRegistry, inspectFile } from '../../src/core/inspect';
import { JobManager } from '../../src/core/jobs';
import type { OutputSettings } from '../../src/core/output';
import { probeToolchain } from '../../src/core/tools';
import './printer';

const require = createRequire(import.meta.url);

function npmBinary(moduleName: string): (() => string | undefined) {
  return () => {
    try {
      const value: unknown = require(moduleName);
      if (typeof value === 'string') return value;
      if (value && typeof value === 'object' && 'path' in value && typeof (value).path === 'string') return (value as { path: string }).path;
    } catch {
      /* optional dependency not installed */
    }
    return undefined;
  };
}

let cachedToolchain: Promise<ToolchainSnapshot> | undefined;

/** The real toolchain of the machine running the tests. Tool-dependent suites skip when a tool is absent. */
export function getToolchain(): Promise<ToolchainSnapshot> {
  cachedToolchain ??= probeToolchain({ npmResolvers: { ffmpeg: npmBinary('ffmpeg-static'), ffprobe: npmBinary('@ffprobe-installer/ffprobe') } });
  return cachedToolchain;
}

const created: string[] = [];

/** A fresh temp directory removed after the test file finishes. Tests never touch real user folders. */
export async function makeTempDir(label = 'case'): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `morph-test-${label}-`));
  created.push(dir);
  return dir;
}

afterAll(async () => {
  await Promise.all(created.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

export const DEFAULT_OUTPUT: OutputSettings = { naming: 'same-name', suffix: '_converted', directory: null };

export interface Harness {
  registry: FileRegistry;
  manager: JobManager;
  toolchain: ToolchainSnapshot;
  inspect(filePath: string): Promise<InspectedFile>;
  convert(filePath: string, target: FormatId, options?: Record<string, unknown>): Promise<JobSnapshot>;
  /** Runs a PDF merge or split on already inspected files and waits for it to finish. */
  pdfTool(request: StartPdfToolRequest): Promise<JobSnapshot>;
}

export async function createHarness(overrides: { output?: Partial<OutputSettings>; toolchain?: ToolchainSnapshot; executor?: typeof executeInProcess; concurrency?: number } = {}): Promise<Harness> {
  const toolchain = overrides.toolchain ?? (await getToolchain());
  const registry = new FileRegistry();
  const quality = { jpg: 85, webp: 80, avif: 55 };
  const manager = new JobManager({
    executor: overrides.executor ?? executeInProcess,
    registry,
    getToolchain: () => toolchain,
    getOutputSettings: () => ({ ...DEFAULT_OUTPUT, ...overrides.output }),
    getQuality: () => quality,
    concurrency: overrides.concurrency ?? 2,
  });
  return {
    registry,
    manager,
    toolchain,
    inspect: (filePath) => inspectFile(filePath, registry, { toolchain, quality }),
    async convert(filePath, target, options = {}) {
      const file = await inspectFile(filePath, registry, { toolchain, quality });
      const job = manager.enqueue(file.id, target, options);
      await manager.idle();
      const finished = manager.get(job.id);
      if (!finished) throw new Error('job vanished');
      return finished;
    },
    async pdfTool(request) {
      const job = manager.enqueuePdfTool(request);
      await manager.idle();
      const finished = manager.get(job.id);
      if (!finished) throw new Error('job vanished');
      return finished;
    },
  };
}

export const hasTool = async (id: keyof ToolchainSnapshot['tools']): Promise<boolean> => (await getToolchain()).tools[id].found;
