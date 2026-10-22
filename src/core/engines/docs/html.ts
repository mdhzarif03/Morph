/** Shared HTML shell for documents that are printed to PDF by the application's own Chromium. */

export type PageSize = 'A4' | 'Letter';

/** A document's own page setup, in points. */
export interface PageSpec {
  widthPt: number;
  heightPt: number;
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Scripts, network and plugins are all disabled: the page may only use what is inside this file.
const CSP = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:";

const BASE_CSS = `
  @page { size: __SIZE__; margin: 22mm 20mm; }
  * { box-sizing: border-box; }
  html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  body { font-family: "Segoe UI", "Calibri", "Helvetica Neue", Arial, sans-serif; font-size: 11pt; line-height: 1.45; color: #111; margin: 0; overflow-wrap: anywhere; }
  h1, h2, h3, h4, h5, h6 { line-height: 1.25; margin: 1.1em 0 0.4em; break-after: avoid; }
  h1 { font-size: 20pt; } h2 { font-size: 16pt; } h3 { font-size: 13.5pt; } h4, h5, h6 { font-size: 11.5pt; }
  p { margin: 0 0 0.7em; orphans: 2; widows: 2; }
  ul, ol { margin: 0 0 0.8em; padding-left: 1.6em; }
  table { border-collapse: collapse; margin: 0 0 1em; max-width: 100%; }
  td, th { border: 0.6pt solid #888; padding: 3pt 6pt; vertical-align: top; }
  tr { break-inside: avoid; }
  img { max-width: 100%; height: auto; break-inside: avoid; }
  a { color: #1a4fb4; }
  blockquote { margin: 0 0 0.8em 1.2em; padding-left: 0.8em; border-left: 2pt solid #bbb; color: #333; }
  pre.plain { font-family: Consolas, "Cascadia Mono", "Courier New", monospace; font-size: 10pt; line-height: 1.4; white-space: pre-wrap; margin: 0; tab-size: 4; }
  .center { text-align: center; } .right { text-align: right; } .justify { text-align: justify; }
`;

const NEUTRAL_CSS = `
  * { box-sizing: border-box; }
  html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  body { margin: 0; overflow-wrap: break-word; }
  p { margin: 0; orphans: 2; widows: 2; }
  img { break-inside: avoid; }
  tr { break-inside: avoid; }
  a { color: inherit; }
`;

export interface WrapOptions {
  /** 'plain' adds readable default typography; 'faithful' leaves all styling to the document's own formatting. */
  variant?: 'plain' | 'faithful';
  /** Used when the document has no page setup, or when the user chose a size explicitly. */
  pageSize: PageSize;
  /** Document-defined page setup (faithful variant only). `null`/undefined = use `pageSize`. */
  page?: PageSpec | null;
  /** Default font for text without any font information. */
  baseFont?: { family: string; sizePt: number };
}

export function wrapHtml(bodyHtml: string, options: WrapOptions, title: string): string {
  const variant = options.variant ?? 'plain';
  let css: string;
  if (variant === 'plain') {
    css = BASE_CSS.replace('__SIZE__', options.pageSize === 'Letter' ? 'Letter' : 'A4');
  } else {
    const page = options.page;
    const pageRule = page
      ? `@page { size: ${page.widthPt}pt ${page.heightPt}pt; margin: ${page.top}pt ${page.right}pt ${page.bottom}pt ${page.left}pt; }`
      : `@page { size: ${options.pageSize === 'Letter' ? 'Letter' : 'A4'}; margin: 72pt; }`;
    const base = options.baseFont ? `body { font-family: ${options.baseFont.family}; font-size: ${options.baseFont.sizePt}pt; color: #000; }` : 'body { font-family: "Segoe UI", Arial, sans-serif; font-size: 11pt; color: #000; }';
    css = `${pageRule}\n${NEUTRAL_CSS}\n${base}`;
  }
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${CSP}"><title>${escapeHtml(title)}</title><style>${css}</style></head>
<body>${bodyHtml}</body></html>`;
}
