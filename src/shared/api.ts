import type {
  AppInfo,
  InspectResult,
  JobSnapshot,
  PdfPreviewResponse,
  ShortcutResult,
  ShortcutStatus,
  StartConversionRequest,
  StartPdfToolRequest,
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
  /** Merge PDFs or split / extract pages. Returns the id of the new job. */
  startPdfTool(request: StartPdfToolRequest): Promise<{ jobId: string }>;
  /** Small page images for a PDF the user added, 12 pages at most per call. */
  getPdfPreview(fileId: string, start: number, count: number): Promise<PdfPreviewResponse>;
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
  /** While recording a new shortcut the popup must not hide when Windows briefly takes focus (input-language switch). */
  setShortcutCapture(active: boolean): Promise<void>;
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
  /**
   * Fired each time the popup is shown by the shortcut or tray. `fresh` is true when it was hidden
   * before; `view` is set when the tray asked for a particular page.
   */
  onWindowShown(listener: (info: { focused: boolean; fresh: boolean; view?: 'home' | 'settings' }) => void): Unsubscribe;
  /** Fired when the popup is hidden, however that happened. */
  onWindowHidden(listener: () => void): Unsubscribe;
  onNavigate(listener: (view: 'home' | 'settings') => void): Unsubscribe;
}
