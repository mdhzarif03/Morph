import { BrowserWindow, nativeTheme, screen, shell, session, type Rectangle } from 'electron';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { IPC } from '../shared/ipc';
import type { Logger } from '../core/logger';
import type { TrustedOrigins } from './ipc-guard';

export const WINDOW_WIDTH = 580;
const MIN_HEIGHT = 200;
const TOP_MARGIN_RATIO = 0.08;

export interface WindowManagerOptions {
  /** Directory containing the compiled main + preload scripts. */
  distMain: string;
  /** Directory containing the built renderer (index.html). */
  distRenderer: string;
  devServerUrl: string | undefined;
  iconPath: string | undefined;
  getFocusOnOpen(): boolean;
  getHideOnBlur(): boolean;
  log: Logger;
}

/** The compact floating popup: frameless, always on top, top-centre of the primary display. */
export class WindowManager {
  private window: BrowserWindow | null = null;
  private contentHeight = 360;
  private quitting = false;
  private ready = false;
  private pendingView: 'home' | 'settings' | null = null;
  private blurSuppressions = 0;
  /** True while the shortcut recorder is listening; Windows may take focus for a moment when the keys switch the input language. */
  private capturing = false;
  private captureTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly options: WindowManagerOptions) {}

  get trustedOrigins(): TrustedOrigins {
    const origins: TrustedOrigins = { fileUrlPrefix: pathToFileURL(this.options.distRenderer).href };
    if (this.options.devServerUrl) origins.devServerOrigin = new URL(this.options.devServerUrl).origin;
    return origins;
  }

  /** Keeps the popup open while a native dialog (which takes focus) is showing. */
  async withoutAutoHide<T>(action: () => Promise<T>): Promise<T> {
    this.blurSuppressions += 1;
    try {
      return await action();
    } finally {
      // Give focus a moment to return before blur-to-hide is armed again.
      setTimeout(() => {
        this.blurSuppressions -= 1;
      }, 300);
    }
  }

  /** Keeps the popup open while the user records a new shortcut. Ends by itself after a minute. */
  setShortcutCapture(active: boolean): void {
    clearTimeout(this.captureTimer);
    this.capturing = active;
    if (active) {
      this.captureTimer = setTimeout(() => {
        this.capturing = false;
      }, 60_000);
      this.captureTimer.unref?.();
    }
  }

  /** The popup background follows the theme, so there is no dark flash before the page paints in light mode. */
  private background(): string {
    return nativeTheme.shouldUseDarkColors ? '#141518' : '#f6f7fa';
  }

  refreshBackground(): void {
    this.browserWindow?.setBackgroundColor(this.background());
  }

  markQuitting(): void {
    this.quitting = true;
  }

  get browserWindow(): BrowserWindow | null {
    return this.window && !this.window.isDestroyed() ? this.window : null;
  }

  isVisible(): boolean {
    return this.browserWindow?.isVisible() ?? false;
  }

  isFocused(): boolean {
    return this.browserWindow?.isFocused() ?? false;
  }

  private create(): BrowserWindow {
    const { log } = this.options;
    const window = new BrowserWindow({
      width: WINDOW_WIDTH,
      height: this.contentHeight,
      show: false,
      frame: false,
      resizable: false,
      maximizable: false,
      minimizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      title: 'Morph',
      backgroundColor: this.background(),
      ...(this.options.iconPath ? { icon: this.options.iconPath } : {}),
      webPreferences: {
        preload: path.join(this.options.distMain, 'preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        allowRunningInsecureContent: false,
        spellcheck: false,
        devTools: this.options.devServerUrl !== undefined,
      },
    });

    // Lock the renderer down: no new windows, no navigation away from the app, no permissions.
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (event, url) => {
      if (!this.isAppUrl(url)) event.preventDefault();
    });
    window.webContents.on('will-attach-webview', (event) => event.preventDefault());
    window.webContents.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    window.webContents.session.setPermissionCheckHandler(() => false);
    session.defaultSession.setDevicePermissionHandler(() => false);

    window.on('close', (event) => {
      if (!this.quitting) {
        event.preventDefault();
        window.hide();
      }
    });
    window.on('blur', () => {
      if (this.capturing) return;
      if (this.blurSuppressions === 0 && this.options.getHideOnBlur() && !window.webContents.isDevToolsOpened()) window.hide();
    });
    // However the popup was hidden (Esc, close button, clicking away, the shortcut), the page returns to its start.
    window.on('hide', () => {
      this.capturing = false;
      this.send(IPC.windowHidden, undefined);
    });
    window.webContents.on('render-process-gone', (_e, details) => log.error('renderer gone', { reason: details.reason }));
    window.webContents.on('did-finish-load', () => {
      this.ready = true;
      if (this.pendingView) {
        window.webContents.send(IPC.navigate, this.pendingView);
        this.pendingView = null;
      }
    });

    const url = this.options.devServerUrl ?? pathToFileURL(path.join(this.options.distRenderer, 'index.html')).href;
    void window.loadURL(url).catch((error: unknown) => log.error('failed to load renderer', { error: String(error) }));
    return window;
  }

  private isAppUrl(url: string): boolean {
    const origins = this.trustedOrigins;
    return url.startsWith(origins.fileUrlPrefix) || (origins.devServerOrigin !== undefined && (url === origins.devServerOrigin || url.startsWith(`${origins.devServerOrigin}/`)));
  }

  /** Pre-creates the hidden window so the first shortcut press is instant. */
  warmUp(): void {
    this.window ??= this.create();
  }

  private workArea(): Rectangle {
    return screen.getPrimaryDisplay().workArea;
  }

  private place(window: BrowserWindow): void {
    const area = this.workArea();
    const height = Math.max(MIN_HEIGHT, Math.min(this.contentHeight, Math.floor(area.height * 0.86)));
    const width = Math.min(WINDOW_WIDTH, area.width - 24);
    const x = Math.round(area.x + (area.width - width) / 2);
    const y = Math.round(area.y + area.height * TOP_MARGIN_RATIO);
    window.setBounds({ x, y, width, height }, false);
  }

  /** Reacts to the page reporting its content height, keeping the popup as small as its content. */
  setContentHeight(height: number): void {
    this.contentHeight = Math.ceil(height);
    const window = this.browserWindow;
    if (window?.isVisible()) this.place(window);
  }

  show(options: { view?: 'home' | 'settings'; forceFocus?: boolean } = {}): void {
    this.window ??= this.create();
    const window = this.window;
    const fresh = !window.isVisible();
    this.place(window);

    if (options.view && !this.ready) this.pendingView = options.view;

    const takeFocus = options.forceFocus === true || this.options.getFocusOnOpen() || options.view === 'settings';
    if (takeFocus) {
      window.show();
      window.focus();
    } else {
      // Appear without interrupting typing in the active application.
      window.showInactive();
    }
    window.setAlwaysOnTop(true, 'pop-up-menu');
    if (this.ready) window.webContents.send(IPC.windowShown, { focused: takeFocus, fresh, ...(options.view ? { view: options.view } : {}) });
  }

  hide(): void {
    this.browserWindow?.hide();
  }

  /**
   * Shortcut behaviour: hidden -> show; visible but not focused -> take focus (for keyboard use);
   * visible and focused -> hide.
   */
  toggle(): void {
    const window = this.browserWindow;
    if (!window || !window.isVisible()) {
      this.show();
      return;
    }
    if (window.isFocused()) {
      window.hide();
      return;
    }
    window.show();
    window.focus();
    window.webContents.send(IPC.windowShown, { focused: true, fresh: false });
  }

  send(channel: string, payload: unknown): void {
    const window = this.browserWindow;
    if (window && !window.webContents.isDestroyed()) window.webContents.send(channel, payload);
  }

  openExternalSafely(url: string): void {
    if (/^https:\/\//i.test(url)) void shell.openExternal(url);
  }

  destroy(): void {
    this.window?.destroy();
    this.window = null;
  }
}
