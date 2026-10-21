import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { MorphApi } from '../shared/api';
import { IPC } from '../shared/channels';
import type { InspectResult, JobSnapshot, ShortcutStatus } from '../shared/types';

/**
 * The only bridge between the sandboxed renderer and the main process. It exposes a fixed set of
 * typed functions; the renderer never receives `ipcRenderer`, Node.js APIs or arbitrary channels.
 */
function subscribe<T>(channel: string, listener: (payload: T) => void): () => void {
  const wrapped = (_event: Electron.IpcRendererEvent, payload: T) => listener(payload);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
}

const api: MorphApi = {
  pickFiles: () => ipcRenderer.invoke(IPC.pickFiles) as Promise<InspectResult>,
  inspectDroppedFiles: (files) => {
    // Real paths of dropped files can only be obtained here, from genuine File objects.
    const paths = files.map((file) => webUtils.getPathForFile(file)).filter((p) => p.length > 0);
    if (paths.length === 0) return Promise.resolve({ files: [], rejected: [] });
    return ipcRenderer.invoke(IPC.inspectPaths, { paths }) as Promise<InspectResult>;
  },

  startConversion: (request) => ipcRenderer.invoke(IPC.startConversion, request),
  cancelJob: (jobId) => ipcRenderer.invoke(IPC.cancelJob, { jobId }),
  cancelAll: () => ipcRenderer.invoke(IPC.cancelAll),
  listJobs: () => ipcRenderer.invoke(IPC.listJobs) as Promise<JobSnapshot[]>,
  clearFinished: () => ipcRenderer.invoke(IPC.clearFinished),
  onJobUpdated: (listener) => subscribe<JobSnapshot>(IPC.jobUpdated, listener),

  openOutput: (jobId) => ipcRenderer.invoke(IPC.openOutput, { jobId }),
  showOutput: (jobId) => ipcRenderer.invoke(IPC.showOutput, { jobId }),

  getSettings: () => ipcRenderer.invoke(IPC.getSettings),
  updateSettings: (patch) => ipcRenderer.invoke(IPC.updateSettings, patch),
  setShortcut: (accelerator) => ipcRenderer.invoke(IPC.setShortcut, { accelerator }),
  getShortcutStatus: () => ipcRenderer.invoke(IPC.getShortcutStatus) as Promise<ShortcutStatus>,
  onShortcutStatusChanged: (listener) => subscribe<ShortcutStatus>(IPC.shortcutStatusChanged, listener),
  pickOutputDirectory: () => ipcRenderer.invoke(IPC.pickOutputDirectory),
  pickToolPath: (tool) => ipcRenderer.invoke(IPC.pickToolPath, { tool }),
  clearToolPath: (tool) => ipcRenderer.invoke(IPC.clearToolPath, { tool }),

  getDiagnostics: (refresh) => ipcRenderer.invoke(IPC.getDiagnostics, refresh === undefined ? undefined : { refresh }),
  getAppInfo: () => ipcRenderer.invoke(IPC.getAppInfo),
  openLogs: () => ipcRenderer.invoke(IPC.openLogs),

  hideWindow: () => ipcRenderer.invoke(IPC.hideWindow),
  setContentHeight: (height) => ipcRenderer.invoke(IPC.setContentHeight, { height }),
  onWindowShown: (listener) => subscribe<{ focused: boolean }>(IPC.windowShown, listener),
  onNavigate: (listener) => subscribe<'home' | 'settings'>(IPC.navigate, listener),
};

contextBridge.exposeInMainWorld('morph', api);
