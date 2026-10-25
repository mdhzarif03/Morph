import { useCallback, useRef, useState } from 'react';
import type { PdfPreviewPage } from '../../shared/types';
import { getApi } from './api';

const BATCH = 12;

/**
 * Loads page thumbnails of a PDF a dozen at a time, as the user scrolls. Use one instance per file
 * (give the component a `key` of the file id) so the state starts fresh for each document.
 */
export function usePdfPages(fileId: string) {
  const api = getApi();
  const [pages, setPages] = useState<PdfPreviewPage[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const next = useRef(0);
  const busy = useRef(false);
  const finished = useRef(false);

  const loadMore = useCallback(async () => {
    if (busy.current || finished.current) return;
    busy.current = true;
    try {
      const result = await api.getPdfPreview(fileId, next.current, BATCH);
      setPages((previous) => [...previous, ...result.pages]);
      next.current += result.pages.length;
      if (result.pages.length === 0 || next.current >= result.pageCount) {
        finished.current = true;
        setDone(true);
      }
    } catch (cause) {
      finished.current = true;
      setDone(true);
      setError(cause instanceof Error ? cause.message : 'The page previews could not be created.');
    } finally {
      busy.current = false;
    }
  }, [api, fileId]);

  return { pages, loadMore, done, error };
}
