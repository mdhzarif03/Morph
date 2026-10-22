import { promises as fs } from 'node:fs';
import { BrowserWindow, session } from 'electron';
import { MorphError, cancelledError } from '../shared/errors';
import type { Logger } from '../core/logger';
import type { HtmlPrinter } from '../core/print';

const PRINT_TIMEOUT_MS = 5 * 60_000;

/**
 * Turns a local HTML file into a PDF with the Chromium that ships inside Electron, so no word processor
 * has to be installed. The page is rendered in a hidden, sandboxed window with JavaScript and all
 * network access disabled: it can only show what the generated file itself contains.
 */
export function createElectronPrinter(log: Logger): HtmlPrinter {
  const printSession = session.fromPartition('morph-print'); // in memory, never persisted
  printSession.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: !(details.url.startsWith('file://') || details.url.startsWith('data:')) });
  });

  // One page layout at a time keeps memory use predictable.
  let chain: Promise<unknown> = Promise.resolve();

  const printOne: HtmlPrinter = async (request, signal) => {
    signal.throwIfAborted();
    const window = new BrowserWindow({
      show: false,
      width: 1000,
      height: 1400,
      webPreferences: { session: printSession, sandbox: true, contextIsolation: true, nodeIntegration: false, javascript: false, webSecurity: true, spellcheck: false },
    });
    const timer = setTimeout(() => window.destroy(), PRINT_TIMEOUT_MS);
    const onAbort = () => window.destroy();
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      window.webContents.on('will-navigate', (event) => event.preventDefault());
      window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      await window.loadFile(request.htmlPath);
      const pdf = await window.webContents.printToPDF({ pageSize: request.pageSize, printBackground: true, preferCSSPageSize: true });
      signal.throwIfAborted();
      await fs.writeFile(request.pdfPath, pdf);
    } catch (error) {
      if (signal.aborted) throw cancelledError();
      log.warn('print failed', { error: String(error) });
      throw new MorphError('TOOL_FAILED', 'The document could not be laid out.', { detail: String(error) });
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      if (!window.isDestroyed()) window.destroy();
    }
  };

  return (request, signal) => {
    const run = chain.then(() => printOne(request, signal));
    chain = run.catch(() => undefined);
    return run;
  };
}
