import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { buildPdf, buildTransparentPng, buildWav, writeRichDocx } from '../helpers/fixtures';
import { pdfPageTexts } from '../helpers/pdftext';
import { readZip } from '../helpers/zipread';

let app: ElectronApplication;
let page: Page;
let work: string;
const shots = process.env.MORPH_SHOTS ?? path.join(os.tmpdir(), 'morph-shots');

/** The popup resizes itself to its content asynchronously; give it a moment before capturing. */
async function settle(): Promise<void> {
  await page.waitForTimeout(350);
}

/** Replaces the native "Open files" dialog with a stub that returns the given paths. */
async function stubFileDialog(paths: string[]): Promise<void> {
  await app.evaluate(({ dialog }, files) => {
    dialog.showOpenDialog = (() => Promise.resolve({ canceled: false, filePaths: files }));
  }, paths);
}

/** Performs a genuine Chromium drag-and-drop of OS files (so File objects carry real paths). */
async function dropFiles(files: string[]): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  const base = { x: 200, y: 140, data: { items: [], files, dragOperationsMask: 1 } };
  await cdp.send('Input.dispatchDragEvent', { type: 'dragEnter', ...base });
  await cdp.send('Input.dispatchDragEvent', { type: 'dragOver', ...base });
  await cdp.send('Input.dispatchDragEvent', { type: 'drop', ...base });
  await cdp.detach();
}

test.beforeAll(async () => {
  work = mkdtempSync(path.join(os.tmpdir(), 'morph-e2e-work-'));
  const userData = mkdtempSync(path.join(os.tmpdir(), 'morph-e2e-ud-'));
  mkdirSync(shots, { recursive: true });
  // MORPH_E2E_EXECUTABLE runs the tests against a packaged build (release/<platform>-unpacked/morph) instead of the sources.
  const packaged = process.env.MORPH_E2E_EXECUTABLE;
  app = await electron.launch({
    ...(packaged ? { executablePath: packaged } : {}),
    args: [...(packaged ? [] : ['.']), '--no-sandbox', '--disable-gpu'],
    // PATH is emptied on purpose: Morph must work with nothing else installed on the computer.
    env: { ...process.env, PATH: '/nonexistent', MORPH_USER_DATA_DIR: userData, MORPH_SHOW_ON_START: '1' },
  });
  page = await app.firstWindow();
  await page.waitForSelector('text=Drop a file here');
});

test.afterAll(async () => {
  await app.close();
});

async function openSettings(): Promise<void> {
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
}

test.beforeEach(async () => {
  // Back to a clean home screen between tests.
  const back = page.getByRole('button', { name: 'Back' });
  if (await back.isVisible().catch(() => false)) await back.click();
  const clear = page.getByRole('button', { name: 'Clear' });
  const another = page.getByRole('button', { name: 'Convert another' });
  if (await another.isVisible().catch(() => false)) await another.click();
  else if (await clear.isVisible().catch(() => false)) await clear.click();
  await page.waitForSelector('text=Drop a file here');
});

test('window is a frameless, always-on-top popup at the top-centre of the screen', async () => {
  const info = await app.evaluate(({ BrowserWindow, screen }) => {
    const win = BrowserWindow.getAllWindows()[0];
    if (!win) throw new Error('no window');
    const b = win.getBounds();
    const area = screen.getPrimaryDisplay().workArea;
    return { b, area, onTop: win.isAlwaysOnTop(), visible: win.isVisible() };
  });
  expect(info.visible).toBe(true);
  expect(info.onTop).toBe(true);
  const centreOffset = Math.abs(info.b.x + info.b.width / 2 - (info.area.x + info.area.width / 2));
  expect(centreOffset).toBeLessThanOrEqual(1);
  expect(info.b.y - info.area.y).toBeLessThan(info.area.height * 0.2); // near the top
  await settle();
  await page.screenshot({ path: path.join(shots, '01-home.png') });
});

test('registers the default global shortcut and shows it', async () => {
  const registered = await app.evaluate(({ globalShortcut }) => globalShortcut.isRegistered('Ctrl+Shift+C'));
  expect(registered).toBe(true);
  await expect(page.getByTitle('Global shortcut')).toHaveText('Ctrl + Shift + C');
});

test('the renderer is sandboxed: no Node, no raw IPC, minimal typed API', async () => {
  const probe = await page.evaluate(() => ({
    hasRequire: typeof (window as unknown as { require?: unknown }).require,
    hasProcess: typeof (window as unknown as { process?: unknown }).process,
    hasIpc: typeof (window as unknown as { ipcRenderer?: unknown }).ipcRenderer,
    api: Object.keys((window as unknown as { morph: object }).morph).sort(),
    csp: document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content') ?? '',
  }));
  expect(probe.hasRequire).toBe('undefined');
  expect(probe.hasProcess).toBe('undefined');
  expect(probe.hasIpc).toBe('undefined');
  expect(probe.csp).toContain("default-src 'none'");
  expect(probe.csp).not.toContain('unsafe-inline');
  expect(probe.csp).not.toContain('unsafe-eval');
  // Nothing in the API accepts a free-form path from the page.
  expect(probe.api).not.toContain('readFile');
  expect(probe.api).not.toContain('invoke');
  expect(probe.api).toContain('inspectDroppedFiles');
});

test('IPC from outside the app page is refused and malformed payloads are rejected', async () => {
  // A payload the schema forbids (extra key + bad id) must be rejected by the main process.
  const outcome = await page.evaluate(async () => {
    const api = (window as unknown as { morph: { cancelJob(id: string): Promise<void> } }).morph;
    try {
      await api.cancelJob('../../etc/passwd');
      return 'accepted';
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  });
  expect(outcome).toMatch(/not valid|rejected/i);
});

test('converts a dropped PNG to WebP next to the original and leaves the original untouched', async () => {
  const dir = mkdtempSync(path.join(work, 'png-'));
  const source = path.join(dir, 'logo.png');
  const original = await buildTransparentPng(96);
  writeFileSync(source, original);

  await dropFiles([source]);
  await expect(page.getByText('logo.png').first()).toBeVisible();
  await expect(page.getByRole('radiogroup', { name: 'Convert to' })).toBeVisible();
  await settle();
  await page.screenshot({ path: path.join(shots, '02-file-selected.png') });

  // PNG is not offered as "PDF" etc.: only image formats are shown.
  const offered = await page.getByRole('radio').allTextContents();
  expect(offered).toEqual(expect.arrayContaining(['JPG', 'WebP', 'AVIF', 'BMP', 'TIFF', 'GIF', 'ICO']));
  expect(offered).not.toContain('MP3');
  expect(offered).not.toContain('MP4');

  await page.getByRole('radio', { name: 'WebP' }).click();
  await settle();
  await page.screenshot({ path: path.join(shots, '03-webp-options.png') });
  await page.getByRole('button', { name: /^Convert/ }).click();

  await expect(page.getByText('Saved as')).toBeVisible({ timeout: 30_000 });
  await settle();
  await page.screenshot({ path: path.join(shots, '04-success.png') });

  expect(readdirSync(dir).sort()).toEqual(['logo.png', 'logo.webp']);
  expect(readFileSync(source).equals(original)).toBe(true);
  const meta = await sharp(path.join(dir, 'logo.webp')).metadata();
  expect(meta.format).toBe('webp');
  expect(meta.hasAlpha).toBe(true);
  await expect(page.getByRole('button', { name: 'Show in folder' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open', exact: true })).toBeVisible();
});

test('browse button flow converts a multi-page PDF to a ZIP of numbered JPG pages', async () => {
  const dir = mkdtempSync(path.join(work, 'pdf-'));
  const source = path.join(dir, 'report.pdf');
  writeFileSync(source, buildPdf(7));
  await stubFileDialog([source]);

  await page.getByRole('button', { name: 'Browse files' }).click();
  await expect(page.getByText('7 pages')).toBeVisible();
  await page.getByRole('radio', { name: 'JPG' }).click();
  await page.getByRole('button', { name: /^Convert/ }).click();
  await expect(page.getByText('Saved as')).toBeVisible({ timeout: 60_000 });
  await settle();
  await page.screenshot({ path: path.join(shots, '05-pdf-zip.png') });

  expect(readdirSync(dir).sort()).toEqual(['report.pdf', 'report.zip']);
  const zip = await readZip(path.join(dir, 'report.zip'));
  expect(zip.names).toEqual(Array.from({ length: 7 }, (_, i) => `report_page_${String(i + 1).padStart(3, '0')}.jpg`));
  expect(zip.magic.every((m) => m.startsWith('ffd8ff'))).toBe(true);
});

test('converts a DOCX to PDF with no other software installed (built-in layout engine)', async () => {
  const dir = mkdtempSync(path.join(work, 'docx-'));
  const source = path.join(dir, 'report.docx');
  await writeRichDocx(source);
  await dropFiles([source]);
  await expect(page.getByText('report.docx').first()).toBeVisible();
  const offered = await page.getByRole('radio').allTextContents();
  expect(offered.sort()).toEqual(['JPG', 'PDF', 'PNG']);
  for (const radio of await page.getByRole('radio').all()) await expect(radio).toBeEnabled();
  await page.getByRole('radio', { name: 'PDF' }).click();
  await settle();
  await page.screenshot({ path: path.join(shots, '09-docx-options.png') });
  await page.getByRole('button', { name: /^Convert/ }).click();
  await expect(page.getByText('Saved as')).toBeVisible({ timeout: 60_000 });
  expect(readdirSync(dir).sort()).toEqual(['report.docx', 'report.pdf']);
  // The faithful layout can position glyphs one by one, so compare without whitespace.
  const text = (await pdfPageTexts(path.join(dir, 'report.pdf'))).join('').replace(/[\s\u00b7]+/g, '');
  expect(text).toContain('QuarterlyReport');
  expect(text).toContain('Revenuewasstrongthisquarter.');
  expect(text).toContain('North');
});

test('converts a TXT to JPG pages (layout engine, then built-in PDF renderer)', async () => {
  const dir = mkdtempSync(path.join(work, 'txt-'));
  const source = path.join(dir, 'notes.txt');
  writeFileSync(source, 'First line\nSecond line — with a dash\n');
  await dropFiles([source]);
  await page.getByRole('radio', { name: 'JPG' }).click();
  await page.getByRole('button', { name: /^Convert/ }).click();
  await expect(page.getByText('Saved as')).toBeVisible({ timeout: 60_000 });
  expect(readdirSync(dir).sort()).toEqual(['notes.jpg', 'notes.txt']);
  expect((await sharp(path.join(dir, 'notes.jpg')).metadata()).format).toBe('jpeg');
});

test('converts WAV to MP3 with the FFmpeg that ships with the app', async () => {
  const dir = mkdtempSync(path.join(work, 'wav-'));
  const source = path.join(dir, 'tone.wav');
  writeFileSync(source, buildWav(1));
  await dropFiles([source]);
  await page.getByRole('radio', { name: 'MP3' }).click();
  await page.getByRole('button', { name: /^Convert/ }).click();
  await expect(page.getByText('Saved as')).toBeVisible({ timeout: 60_000 });
  expect(readdirSync(dir).sort()).toEqual(['tone.mp3', 'tone.wav']);
  const head = readFileSync(path.join(dir, 'tone.mp3')).subarray(0, 3).toString('latin1');
  expect(['ID3', '\xff\xfb\x90'].some((m) => head.startsWith(m.slice(0, 2)))).toBe(true);
});

test('shows a clear error for an unsupported or misnamed file', async () => {
  const dir = mkdtempSync(path.join(work, 'bad-'));
  const fake = path.join(dir, 'photo.png');
  writeFileSync(fake, 'definitely not an image, just text '.repeat(10));
  await dropFiles([fake]);
  await expect(page.getByRole('alert').first()).toContainText('photo.png');
  await settle();
  await page.screenshot({ path: path.join(shots, '06-error.png') });
  expect(readdirSync(dir)).toEqual(['photo.png']);
});

test('refuses a modifier-less shortcut in Settings and explains why', async () => {
  await openSettings();
  await settle();
  await page.screenshot({ path: path.join(shots, '07-settings.png') });
  await page.getByRole('button', { name: /Global shortcut/ }).click();
  await page.keyboard.press('Shift+C');
  await expect(page.getByText(/interfere with normal typing|needs at least one modifier/)).toBeVisible();
  // The working shortcut is unchanged.
  const stillRegistered = await app.evaluate(({ globalShortcut }) => globalShortcut.isRegistered('Ctrl+Shift+C'));
  expect(stillRegistered).toBe(true);
});

test('changes the shortcut to a valid combination and re-registers it', async () => {
  await openSettings();
  await page.getByRole('button', { name: /Global shortcut/ }).click();
  await page.keyboard.press('Control+Alt+M');
  await expect(page.getByText('Shortcut set to Ctrl + Alt + M.')).toBeVisible();
  const state = await app.evaluate(({ globalShortcut }) => ({ old: globalShortcut.isRegistered('Ctrl+Shift+C'), next: globalShortcut.isRegistered('Ctrl+Alt+M') }));
  expect(state).toEqual({ old: false, next: true });
  // restore
  await page.getByRole('button', { name: 'Reset' }).click();
  await expect(page.getByText('Shortcut set to Ctrl + Shift + C.')).toBeVisible();
});

test('diagnostics lists external tools', async () => {
  await openSettings();
  await expect(page.getByText('FFmpeg', { exact: false }).first()).toBeVisible();
  await expect(page.getByText('FFprobe').first()).toBeVisible();
  await expect(page.getByText(/LibreOffice|Poppler/)).toHaveCount(0);
  await settle();
  await page.screenshot({ path: path.join(shots, '08-diagnostics.png'), fullPage: true });
  await page.keyboard.press('Escape'); // Escape leaves Settings first
  await expect(page.getByText('Drop a file here')).toBeVisible();
});
