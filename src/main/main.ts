import { app, globalShortcut, Menu, nativeImage, Notification, Tray } from 'electron';
import path from 'node:path';
import { createWorkerExecutor } from '../core/worker/pool';
import { FileRegistry } from '../core/inspect';
import { JobManager } from '../core/jobs';
import { createFileLogger } from './file-logger';
import { registerIpc } from './ipc';
import { SettingsStore } from './settings-store';
import { ShortcutManager } from './shortcut-manager';
import { ToolchainService, bundledVendorRoots, unpackedPath } from './toolchain-service';
import { WindowManager } from './window';
import { IPC } from '../shared/ipc';

// Tests (and portable installs) can relocate user data.
const overrideUserData = process.env.MORPH_USER_DATA_DIR;
if (overrideUserData) app.setPath('userData', overrideUserData);

app.setAppUserModelId('app.morph.converter');

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  void start();
}

async function start(): Promise<void> {
  await app.whenReady();

  const logsPath = path.join(app.getPath('userData'), 'logs');
  const log = createFileLogger(logsPath, !app.isPackaged);
  log.info('starting', { version: app.getVersion(), electron: process.versions.electron, packaged: app.isPackaged });

  const appRoot = app.getAppPath();
  const devServerUrl = app.isPackaged ? undefined : process.env.VITE_DEV_SERVER_URL;
  const resourcesDir = app.isPackaged ? process.resourcesPath : path.join(appRoot, 'resources');
  const iconFile = path.join(app.isPackaged ? process.resourcesPath : path.join(appRoot, 'build'), app.isPackaged ? 'icon.png' : 'icon.png');

  const settings = new SettingsStore(path.join(app.getPath('userData'), 'settings.json'), log);
  await settings.load();

  const toolchain = new ToolchainService({
    bundledRoots: bundledVendorRoots(process.resourcesPath, appRoot, app.isPackaged),
    getOverrides: () => settings.get().toolPaths,
  });
  await toolchain.refresh();
  log.info('toolchain', Object.fromEntries(Object.entries(toolchain.current().tools).map(([id, t]) => [id, t.found ? (t.source ?? 'found') : 'missing'])));

  const registry = new FileRegistry();
  const workerFile = unpackedPath(path.join(__dirname, 'worker.cjs'));
  const jobs = new JobManager({
    executor: createWorkerExecutor(workerFile),
    registry,
    getToolchain: () => toolchain.current(),
    getOutputSettings: () => {
      const s = settings.get();
      return { naming: s.outputNaming, suffix: s.outputSuffix, directory: s.outputDirectory };
    },
    getQuality: () => settings.get().imageQuality,
    log,
    concurrency: 2,
  });

  const windows = new WindowManager({
    distMain: __dirname,
    distRenderer: path.join(appRoot, 'dist', 'renderer'),
    devServerUrl,
    iconPath: iconFile,
    getFocusOnOpen: () => settings.get().focusOnOpen,
    getHideOnBlur: () => settings.get().hideOnBlur,
    log,
  });

  const shortcuts = new ShortcutManager(globalShortcut, () => windows.toggle(), settings.get().shortcut, log);
  const shortcutStatus = shortcuts.start();

  const applyLaunchAtLogin = (enabled: boolean) => {
    if (!app.isPackaged) return; // never register the dev electron binary as a login item
    app.setLoginItemSettings({ openAtLogin: enabled, args: enabled ? ['--background'] : [] });
  };
  applyLaunchAtLogin(settings.get().launchAtLogin);

  registerIpc({ settings, toolchain, shortcuts, jobs, registry, windows, log, logsPath, applyLaunchAtLogin });

  // ---- Job events -> renderer, and a notification once a batch is finished ----------------
  let finishedInBatch = 0;
  let failedInBatch = 0;
  jobs.on('updated', (snapshot) => {
    windows.send(IPC.jobUpdated, snapshot);
    if (snapshot.status === 'succeeded') finishedInBatch += 1;
    if (snapshot.status === 'failed') failedInBatch += 1;
    if (!jobs.hasActiveJobs() && finishedInBatch + failedInBatch > 0 && ['succeeded', 'failed'].includes(snapshot.status)) {
      const ok = finishedInBatch;
      const bad = failedInBatch;
      finishedInBatch = 0;
      failedInBatch = 0;
      if (settings.get().notifications && !windows.isFocused() && Notification.isSupported()) {
        const body = bad === 0 ? (ok === 1 ? `${snapshot.sourceName} is ready.` : `${ok} files converted.`) : `${ok} converted, ${bad} failed.`;
        new Notification({ title: bad === 0 ? 'Conversion complete' : 'Conversion finished with errors', body, silent: true }).show();
      }
    }
  });

  // ---- Tray ------------------------------------------------------------------------------
  const trayImage = nativeImage.createFromPath(path.join(resourcesDir, 'tray.png'));
  const tray = new Tray(trayImage.isEmpty() ? nativeImage.createEmpty() : trayImage);
  const refreshTray = () => {
    const accel = shortcuts.status();
    tray.setToolTip(accel.registered ? `Morph — ${accel.accelerator.split('+').join(' + ')}` : 'Morph — shortcut not active');
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: 'Open Morph', click: () => windows.show({ forceFocus: true }) },
        { label: 'Settings', click: () => windows.show({ view: 'settings', forceFocus: true }) },
        { type: 'separator' },
        { label: 'Quit Morph', click: () => app.quit() },
      ]),
    );
  };
  refreshTray();
  settings.on('changed', refreshTray);
  tray.on('click', () => windows.show({ forceFocus: true }));

  app.on('second-instance', () => windows.show({ forceFocus: true }));
  app.on('window-all-closed', () => {
    /* stay in the background; the tray and shortcut keep running */
  });
  app.on('before-quit', () => {
    windows.markQuitting();
    jobs.cancelAll();
  });
  app.on('will-quit', () => shortcuts.dispose());

  windows.warmUp();

  // First run (not launched at login): show the popup once so the user sees it working.
  const background = process.argv.includes('--background');
  if (!background && (!settings.get().welcomeShown || !shortcutStatus.registered || process.env.MORPH_SHOW_ON_START === '1')) {
    windows.show({ forceFocus: true });
  }
}
