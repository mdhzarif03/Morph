import type {
  AppInfo,
  InspectResult,
  JobSnapshot,
  ShortcutResult,
  ShortcutStatus,
  StartConversionRequest,
  StartConversionResponse,
  ToolId,
  ToolchainSnapshot,
} from './types';
import type { Settings, SettingsPatch } from './settings';

export type Unsubscribe = () => void;

/** The only surface the renderer can use to reach the operating system. Exposed by the preload script. */
export interface MorphApi {
  // Files
  pickFiles(): Promise<InspectResult>;
  /** Resolves real paths for dropped File objects (via webUtils) and inspects them. */
  inspectDroppedFiles(files: File[]): Promise<InspectResult>;

  // Conversion
  startConversion(request: StartConversionRequest): Promise<StartConversionResponse>;
  cancelJob(jobId: string): Promise<void>;
  cancelAll(): Promise<void>;
  listJobs(): Promise<JobSnapshot[]>;
  clearFinished(): Promise<void>;
  onJobUpdated(listener: (job: JobSnapshot) => void): Unsubscribe;

  // Results
  openOutput(jobId: string): Promise<{ ok: boolean; message?: string }>;
  showOutput(jobId: string): Promise<{ ok: boolean; message?: string }>;

  // Settings
  getSettings(): Promise<Settings>;
  updateSettings(patch: SettingsPatch): Promise<Settings>;
  setShortcut(accelerator: string): Promise<ShortcutResult>;
  getShortcutStatus(): Promise<ShortcutStatus>;
  onShortcutStatusChanged(listener: (status: ShortcutStatus) => void): Unsubscribe;
  pickOutputDirectory(): Promise<Settings | null>;
  pickToolPath(tool: ToolId): Promise<ToolchainSnapshot | null>;
  clearToolPath(tool: ToolId): Promise<ToolchainSnapshot>;

  // Diagnostics
  getDiagnostics(refresh?: boolean): Promise<ToolchainSnapshot>;
  getAppInfo(): Promise<AppInfo>;
  openLogs(): Promise<void>;

  // Window
  hideWindow(): Promise<void>;
  setContentHeight(height: number): Promise<void>;
  /** Fired each time the popup is shown by the shortcut or tray. */
  onWindowShown(listener: (info: { focused: boolean }) => void): Unsubscribe;
  onNavigate(listener: (view: 'home' | 'settings') => void): Unsubscribe;
}
