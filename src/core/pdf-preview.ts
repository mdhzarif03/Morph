import { MorphError } from '../shared/errors';
import type { PdfPreviewResponse } from '../shared/types';
import { openPdfPreview, type PdfPreviewSession } from './engines/pdf';
import type { FileRegistry } from './inspect';
import { statRegularFile } from './fsutil';

const IDLE_CLOSE_MS = 60_000;
const MAX_OPEN = 3;
const THUMBNAIL_WIDTH_PX = 220;
export const MAX_PREVIEW_BATCH = 12;

interface Entry {
  session: Promise<PdfPreviewSession>;
  timer: ReturnType<typeof setTimeout>;
  lastUsed: number;
}

/**
 * Renders page thumbnails for PDFs the user added. Documents stay open for a minute after the last
 * request, so scrolling through a long file does not re-read it each time, and at most three are open.
 */
export class PdfPreviewService {
  private readonly open = new Map<string, Entry>();

  constructor(private readonly registry: FileRegistry) {}

  async pages(fileId: string, start: number, count: number): Promise<PdfPreviewResponse> {
    const file = this.registry.get(fileId);
    if (!file) throw new MorphError('INVALID_INPUT', 'That file is no longer available. Add it again.');
    if (file.format !== 'pdf') throw new MorphError('INVALID_INPUT', 'Only PDF files have page previews.');
    const current = await statRegularFile(file.realPath);
    if (current.size !== file.size || Math.abs(current.mtimeMs - file.mtimeMs) > 1) {
      throw new MorphError('SOURCE_CHANGED', 'The file was modified after it was added. Add it again to preview the current version.');
    }
    const session = await this.session(fileId, file.realPath);
    const pages = await session.thumbnails(start, Math.min(count, MAX_PREVIEW_BATCH), THUMBNAIL_WIDTH_PX);
    return { pageCount: session.pageCount, pages };
  }

  private async session(fileId: string, realPath: string): Promise<PdfPreviewSession> {
    let entry = this.open.get(fileId);
    if (!entry) {
      while (this.open.size >= MAX_OPEN) this.closeOldest();
      const session = openPdfPreview(realPath);
      entry = { session, timer: setTimeout(() => this.close(fileId), IDLE_CLOSE_MS), lastUsed: Date.now() };
      this.open.set(fileId, entry);
      session.catch(() => this.open.delete(fileId));
    }
    entry.lastUsed = Date.now();
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => this.close(fileId), IDLE_CLOSE_MS);
    entry.timer.unref?.();
    return entry.session;
  }

  private closeOldest(): void {
    let oldest: string | undefined;
    let time = Infinity;
    for (const [id, entry] of this.open) {
      if (entry.lastUsed < time) {
        time = entry.lastUsed;
        oldest = id;
      }
    }
    if (oldest) this.close(oldest);
  }

  private close(fileId: string): void {
    const entry = this.open.get(fileId);
    if (!entry) return;
    this.open.delete(fileId);
    clearTimeout(entry.timer);
    void entry.session.then((s) => s.close(), () => undefined);
  }

  dispose(): void {
    for (const id of [...this.open.keys()]) this.close(id);
  }
}
