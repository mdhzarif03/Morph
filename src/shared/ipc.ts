import { z } from 'zod';
import { FORMAT_IDS } from './formats';
import { SettingsPatchSchema } from './settings';

import { IPC } from './channels';

export { IPC };

export type InvokeChannel =
  | typeof IPC.pickFiles
  | typeof IPC.inspectPaths
  | typeof IPC.startConversion
  | typeof IPC.cancelJob
  | typeof IPC.cancelAll
  | typeof IPC.listJobs
  | typeof IPC.clearFinished
  | typeof IPC.openOutput
  | typeof IPC.showOutput
  | typeof IPC.getSettings
  | typeof IPC.updateSettings
  | typeof IPC.setShortcut
  | typeof IPC.pickOutputDirectory
  | typeof IPC.pickToolPath
  | typeof IPC.clearToolPath
  | typeof IPC.getShortcutStatus
  | typeof IPC.getDiagnostics
  | typeof IPC.getAppInfo
  | typeof IPC.startPdfTool
  | typeof IPC.pdfPreview
  | typeof IPC.setShortcutCapture
  | typeof IPC.hideWindow
  | typeof IPC.setContentHeight
  | typeof IPC.openLogs;

export const MAX_FILES_PER_REQUEST = 200;

const id = z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/);
const absolutePath = z.string().min(1).max(4096).refine((p) => !p.includes('\0'), 'Invalid path');
const toolId = z.enum(['ffmpeg', 'ffprobe']);

// Option values are validated against the registry's specs in the main process; here we only
// bound their shape so a hostile renderer cannot send arbitrarily large or nested data.
const optionValue = z.union([z.string().max(256), z.number().finite(), z.boolean(), z.null()]);

const pageNumber = z.number().int().min(1).max(100_000);
const pdfItem = z.strictObject({ fileId: id, pages: z.array(pageNumber).min(1).max(10_000).optional() });

export const schemas = {
  empty: z.undefined().or(z.null()),
  inspectPaths: z.strictObject({ paths: z.array(absolutePath).min(1).max(MAX_FILES_PER_REQUEST) }),
  startConversion: z.strictObject({
    fileIds: z.array(id).min(1).max(MAX_FILES_PER_REQUEST),
    target: z.enum(FORMAT_IDS),
    options: z.record(z.string().max(64), optionValue).refine((o) => Object.keys(o).length <= 32, 'Too many options'),
  }),
  startPdfTool: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('merge'), items: z.array(pdfItem).min(2).max(100) }),
    z.strictObject({
      kind: z.literal('split'),
      item: pdfItem,
      mode: z.enum(['extract', 'each', 'ranges', 'every']),
      ranges: z.string().max(400).regex(/^[0-9,\-\s]*$/).optional(),
      every: z.number().int().min(1).max(10_000).optional(),
    }),
  ]),
  pdfPreview: z.strictObject({ fileId: id, start: z.number().int().min(0).max(100_000), count: z.number().int().min(1).max(12) }),
  setShortcutCapture: z.strictObject({ active: z.boolean() }),
  jobId: z.strictObject({ jobId: id }),
  openOutput: z.strictObject({ jobId: id }),
  updateSettings: SettingsPatchSchema,
  setShortcut: z.strictObject({ accelerator: z.string().min(1).max(64) }),
  pickToolPath: z.strictObject({ tool: toolId }),
  clearToolPath: z.strictObject({ tool: toolId }),
  getDiagnostics: z.strictObject({ refresh: z.boolean().optional() }).optional(),
  setContentHeight: z.strictObject({ height: z.number().finite().min(0).max(10_000) }),
} as const;
