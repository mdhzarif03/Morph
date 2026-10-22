import { app, dialog, ipcMain, shell, type IpcMainInvokeEvent } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { z } from 'zod';
import { MorphError, toErrorInfo } from '../shared/errors';
import { IPC, schemas, type InvokeChannel } from '../shared/ipc';
import type { AppInfo, InspectResult, ShortcutResult, StartConversionResponse, ToolId, ToolchainSnapshot } from '../shared/types';
import type { Settings } from '../shared/settings';
import type { Logger } from '../core/logger';
import type { FileRegistry } from '../core/inspect';
import { inspectFiles } from '../core/inspect';
import type { JobManager } from '../core/jobs';
import { isTrustedSender, parsePayload } from './ipc-guard';
import type { SettingsStore } from './settings-store';
import type { ShortcutManager } from './shortcut-manager';
import type { ToolchainService } from './toolchain-service';
import type { WindowManager } from './window';

export interface IpcContext {
  settings: SettingsStore;
  toolchain: ToolchainService;
  shortcuts: ShortcutManager;
  jobs: JobManager;
  registry: FileRegistry;
  windows: WindowManager;
  log: Logger;
  logsPath: string;
  applyLaunchAtLogin(enabled: boolean): void;
}

const EXPECTED_EXECUTABLE: Record<ToolId, string> = {
  ffmpeg: 'ffmpeg',
  ffprobe: 'ffprobe',
};

/** Message shown to the user for failures that are not already MorphErrors. */
function sanitize(error: unknown): Error {
  const info = toErrorInfo(error);
  return new Error(info.message);
}

export function registerIpc(ctx: IpcContext): void {
  const handle = <S extends z.ZodType, R>(channel: InvokeChannel, schema: S, handler: (payload: z.infer<S>) => Promise<R> | R) => {
    ipcMain.handle(channel, async (event: IpcMainInvokeEvent, payload: unknown) => {
      if (!isTrustedSender(event, ctx.windows.trustedOrigins)) {
        ctx.log.warn('rejected IPC from untrusted sender', { channel });
        throw new Error('Request rejected.');
      }
      try {
        return await handler(parsePayload(schema, payload));
      } catch (error) {
        const info = toErrorInfo(error);
        if (info.code === 'INTERNAL') ctx.log.error('ipc handler failed', { channel, detail: info.detail });
        throw sanitize(error);
      }
    });
  };

  const env = () => {
    const { imageQuality } = ctx.settings.get();
    return { toolchain: ctx.toolchain.current(), quality: imageQuality };
  };

  const inspect = (paths: string[]): Promise<InspectResult> => inspectFiles(paths, ctx.registry, env());

  // ---- Files -----------------------------------------------------------------------------
  handle(IPC.pickFiles, schemas.empty, async (): Promise<InspectResult> => {
    const parent = ctx.windows.browserWindow;
    const result = await ctx.windows.withoutAutoHide(() =>
      parent
        ? dialog.showOpenDialog(parent, { title: 'Choose files to convert', properties: ['openFile', 'multiSelections'] })
        : dialog.showOpenDialog({ title: 'Choose files to convert', properties: ['openFile', 'multiSelections'] }),
    );
    if (result.canceled || result.filePaths.length === 0) return { files: [], rejected: [] };
    return inspect(result.filePaths);
  });

  handle(IPC.inspectPaths, schemas.inspectPaths, ({ paths }) => inspect(paths));

  // ---- Jobs ------------------------------------------------------------------------------
  handle(IPC.startConversion, schemas.startConversion, ({ fileIds, target, options }): StartConversionResponse => {
    const response: StartConversionResponse = { jobIds: [], rejected: [] };
    for (const fileId of fileIds) {
      try {
        response.jobIds.push(ctx.jobs.enqueue(fileId, target, options).id);
      } catch (error) {
        response.rejected.push({ fileId, error: toErrorInfo(error) });
      }
    }
    return response;
  });
  handle(IPC.cancelJob, schemas.jobId, ({ jobId }) => ctx.jobs.cancel(jobId));
  handle(IPC.cancelAll, schemas.empty, () => ctx.jobs.cancelAll());
  handle(IPC.listJobs, schemas.empty, () => ctx.jobs.list());
  handle(IPC.clearFinished, schemas.empty, () => ctx.jobs.clearFinished());

  const outputOf = async (jobId: string): Promise<string> => {
    const job = ctx.jobs.get(jobId);
    const output = job?.primaryOutput;
    if (!job || job.status !== 'succeeded' || !output) throw new MorphError('INVALID_INPUT', 'There is no output for that conversion.');
    try {
      await fs.access(output);
    } catch {
      throw new MorphError('INVALID_INPUT', 'The converted file has been moved or deleted.');
    }
    return output;
  };

  // The renderer can only ask to open the output of a finished job; it can never name a path.
  handle(IPC.openOutput, schemas.openOutput, async ({ jobId }) => {
    const output = await outputOf(jobId);
    const failure = await shell.openPath(output);
    return failure ? { ok: false, message: 'Windows could not open this file with any installed app.' } : { ok: true };
  });
  handle(IPC.showOutput, schemas.openOutput, async ({ jobId }) => {
    shell.showItemInFolder(await outputOf(jobId));
    return { ok: true };
  });

  // ---- Settings --------------------------------------------------------------------------
  handle(IPC.getSettings, schemas.empty, (): Settings => ctx.settings.get());
  handle(IPC.updateSettings, schemas.updateSettings, async (patch): Promise<Settings> => {
    const next = await ctx.settings.update(patch);
    if (patch.launchAtLogin !== undefined) ctx.applyLaunchAtLogin(patch.launchAtLogin);
    return next;
  });
  handle(IPC.setShortcut, schemas.setShortcut, async ({ accelerator }): Promise<ShortcutResult> => {
    const result = ctx.shortcuts.set(accelerator);
    if (result.ok) await ctx.settings.setShortcut(result.status.accelerator);
    return result;
  });
  handle(IPC.getShortcutStatus, schemas.empty, () => ctx.shortcuts.status());

  handle(IPC.pickOutputDirectory, schemas.empty, async (): Promise<Settings | null> => {
    const parent = ctx.windows.browserWindow;
    const options = { title: 'Choose where converted files are saved', properties: ['openDirectory' as const, 'createDirectory' as const] };
    const result = await ctx.windows.withoutAutoHide(() => (parent ? dialog.showOpenDialog(parent, options) : dialog.showOpenDialog(options)));
    const chosen = result.filePaths[0];
    if (result.canceled || !chosen) return null;
    return ctx.settings.setOutputDirectory(chosen);
  });

  handle(IPC.pickToolPath, schemas.pickToolPath, async ({ tool }): Promise<ToolchainSnapshot | null> => {
    const parent = ctx.windows.browserWindow;
    const options = {
      title: `Locate ${EXPECTED_EXECUTABLE[tool]}`,
      properties: ['openFile' as const],
      filters: process.platform === 'win32' ? [{ name: 'Program', extensions: ['exe'] }] : [],
    };
    const result = await ctx.windows.withoutAutoHide(() => (parent ? dialog.showOpenDialog(parent, options) : dialog.showOpenDialog(options)));
    const chosen = result.filePaths[0];
    if (result.canceled || !chosen) return null;
    const baseName = path.basename(chosen, path.extname(chosen)).toLowerCase();
    if (baseName !== EXPECTED_EXECUTABLE[tool]) {
      throw new MorphError('INVALID_INPUT', `That file is not ${EXPECTED_EXECUTABLE[tool]}. Choose the program named “${EXPECTED_EXECUTABLE[tool]}”.`);
    }
    await ctx.settings.setToolPath(tool, chosen);
    return ctx.toolchain.refresh();
  });
  handle(IPC.clearToolPath, schemas.clearToolPath, async ({ tool }) => {
    await ctx.settings.setToolPath(tool, null);
    return ctx.toolchain.refresh();
  });

  // ---- Diagnostics & window --------------------------------------------------------------
  handle(IPC.getDiagnostics, schemas.getDiagnostics, (payload) => (payload?.refresh ? ctx.toolchain.refresh() : ctx.toolchain.get()));
  handle(IPC.getAppInfo, schemas.empty, (): AppInfo => ({
    name: app.getName(),
    version: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    platform: process.platform,
    arch: process.arch,
    isPackaged: app.isPackaged,
    userDataPath: app.getPath('userData'),
    logsPath: ctx.logsPath,
  }));
  handle(IPC.hideWindow, schemas.empty, () => ctx.windows.hide());
  handle(IPC.setContentHeight, schemas.setContentHeight, ({ height }) => ctx.windows.setContentHeight(height));
  handle(IPC.openLogs, schemas.empty, async () => {
    await shell.openPath(ctx.logsPath);
  });
}
