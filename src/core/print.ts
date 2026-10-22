import type { PageSize } from './engines/docs/html';

export interface PrintRequest {
  /** HTML file to render (already contains its own CSP, no external resources). */
  htmlPath: string;
  /** Where the PDF is written. */
  pdfPath: string;
  pageSize: PageSize;
}

/** Turns a local HTML file into a PDF. Implemented by Electron's Chromium in the app (see src/main/printer.ts). */
export type HtmlPrinter = (request: PrintRequest, signal: AbortSignal) => Promise<void>;

let printer: HtmlPrinter | null = null;

/** Installed once per process/thread: by the worker (bridge to the main process) or by tests. */
export function setHtmlPrinter(next: HtmlPrinter | null): void {
  printer = next;
}

export function getHtmlPrinter(): HtmlPrinter {
  if (!printer) throw new Error('No HTML-to-PDF printer is installed in this process.');
  return printer;
}
