import { chromium, type Browser } from '@playwright/test';
import { afterAll } from 'vitest';
import { setHtmlPrinter, type HtmlPrinter } from '../../src/core/print';

/**
 * In the app, HTML is printed by Electron's Chromium (src/main/printer.ts). Unit/integration tests run in
 * plain Node, so they use Playwright's Chromium with the same settings (no JavaScript, CSS page size).
 * The end-to-end tests exercise the real Electron printer.
 */
let browserPromise: Promise<Browser | null> | undefined;

function getBrowser(): Promise<Browser | null> {
  // Default Playwright browser first; then an explicit executable (CHROMIUM_PATH, or the pre-installed
  // /opt/pw-browsers/chromium some environments provide when the bundled revision is not downloaded).
  browserPromise ??= chromium
    .launch({ args: ['--no-sandbox'] })
    .catch(() => chromium.launch({ args: ['--no-sandbox'], executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium' }))
    .catch(() => null);
  return browserPromise;
}

export async function printerAvailable(): Promise<boolean> {
  return (await getBrowser()) !== null;
}

const printer: HtmlPrinter = async (request, signal) => {
  signal.throwIfAborted();
  const browser = await getBrowser();
  if (!browser) throw new Error('Chromium is not available for tests');
  const context = await browser.newContext({ javaScriptEnabled: false, offline: true });
  try {
    const page = await context.newPage();
    await page.goto(`file://${request.htmlPath}`);
    await page.pdf({ path: request.pdfPath, format: request.pageSize, printBackground: true, preferCSSPageSize: true });
  } finally {
    await context.close();
  }
};

setHtmlPrinter(printer);

afterAll(async () => {
  const browser = await (browserPromise ?? Promise.resolve(null));
  await browser?.close().catch(() => undefined);
  browserPromise = undefined;
});
