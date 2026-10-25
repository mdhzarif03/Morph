import { Check } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { usePdfPages } from '../../lib/pdfPages';

interface Props {
  fileId: string;
  pageCount: number;
  /** 1-based page numbers that are included. */
  selected: ReadonlySet<number>;
  onChange: (next: Set<number>) => void;
}

const SKELETONS = 4;

/** Thumbnails of every page. Clicking a page includes or excludes it; Shift+click does a whole range. */
export function PageGrid({ fileId, pageCount, selected, onChange }: Props) {
  const { pages, loadMore, done, error } = usePdfPages(fileId);
  const sentinel = useRef<HTMLDivElement>(null);
  const last = useRef<number | null>(null);

  useEffect(() => {
    const el = sentinel.current;
    if (!el || done) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) void loadMore();
    }, { rootMargin: '400px' });
    observer.observe(el);
    return () => observer.disconnect();
    // Re-observe after each batch so a sentinel that is still on screen asks for the next one.
  }, [loadMore, done, pages.length]);

  const toggle = (page: number, shift: boolean) => {
    const next = new Set(selected);
    if (shift && last.current !== null) {
      const [from, to] = last.current < page ? [last.current, page] : [page, last.current];
      const turnOn = !selected.has(page);
      for (let p = from; p <= to; p += 1) {
        if (turnOn) next.add(p);
        else next.delete(p);
      }
    } else if (next.has(page)) next.delete(page);
    else next.add(page);
    last.current = page;
    onChange(next);
  };

  const skeletons = done ? 0 : Math.min(SKELETONS, Math.max(0, pageCount - pages.length));

  return (
    <div>
      <ul className="grid grid-cols-4 gap-2" aria-label="Pages">
        {pages.map((page) => {
          const on = selected.has(page.page);
          return (
            <li key={page.page}>
              <button
                type="button"
                aria-pressed={on}
                aria-label={`Page ${page.page}${on ? ', included' : ', not included'}`}
                onClick={(e) => toggle(page.page, e.shiftKey)}
                className={`no-drag group relative block w-full overflow-hidden rounded-lg border bg-white transition ${on ? 'border-accent ring-1 ring-accent' : 'border-line opacity-45 hover:opacity-80'}`}
                style={{ aspectRatio: `${page.widthPt} / ${page.heightPt}` }}
              >
                {page.src ? <img src={page.src} alt="" draggable={false} className="size-full object-contain" /> : <span className="grid size-full place-items-center text-[11px] text-neutral-500">No preview</span>}
                <span className="absolute bottom-1 left-1 rounded bg-black/70 px-1.5 text-[10px] font-medium tabular-nums text-white">{page.page}</span>
                {on && (
                  <span className="absolute right-1 top-1 grid size-4 place-items-center rounded-full bg-accent text-accent-ink">
                    <Check size={11} strokeWidth={3} aria-hidden />
                  </span>
                )}
              </button>
            </li>
          );
        })}
        {Array.from({ length: skeletons }, (_, i) => (
          <li key={`s${i}`} aria-hidden>
            <div className="animate-pulse rounded-lg bg-raised" style={{ aspectRatio: '210 / 297' }} />
          </li>
        ))}
      </ul>
      {error && <p className="mt-2 text-xs text-bad">{error}</p>}
      <div ref={sentinel} className="h-px" aria-hidden />
    </div>
  );
}
