import { ArrowDown, ArrowUp, FilePlus2, FolderOpen, Merge, Scissors, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { InspectedFile, InspectResult, JobSnapshot, StartPdfToolRequest } from '../../../shared/types';
import { getApi } from '../../lib/api';
import { formatBytes, plural } from '../../lib/format';
import { isFinished } from '../../lib/state';
import { JobRow } from '../JobRow';
import { Button, IconButton, Notice } from '../ui';
import { PageGrid } from './PageGrid';

type Tab = 'merge' | 'split';
type SplitMode = 'extract' | 'each' | 'ranges' | 'every';

interface PdfEntry {
  file: InspectedFile;
  /** Included pages, 1-based. */
  keep: Set<number>;
}

const pageCountOf = (file: InspectedFile) => file.details.pages ?? 0;
const allPages = (count: number) => new Set(Array.from({ length: count }, (_, i) => i + 1));
const entryOf = (file: InspectedFile): PdfEntry => ({ file, keep: allPages(pageCountOf(file)) });
const sorted = (set: ReadonlySet<number>) => [...set].sort((a, b) => a - b);

interface Props {
  jobs: Record<string, JobSnapshot>;
  /** PDFs that were already on the home page when this screen was opened. */
  seedFiles: InspectedFile[];
  actionErrors: Record<string, string>;
  registerDrop: (handler: ((files: File[]) => void) | null) => void;
  onCancel: (jobId: string) => void;
  onOpen: (jobId: string) => void;
  onShow: (jobId: string) => void;
}

export function PdfTools({ jobs, seedFiles, actionErrors, registerDrop, onCancel, onOpen, onShow }: Props) {
  const api = getApi();
  const [tab, setTab] = useState<Tab>(seedFiles.length === 1 ? 'split' : 'merge');
  const [merge, setMerge] = useState<PdfEntry[]>(() => (seedFiles.length >= 2 ? seedFiles.map(entryOf) : []));
  const [split, setSplit] = useState<PdfEntry | null>(() => (seedFiles.length === 1 && seedFiles[0] ? entryOf(seedFiles[0]) : null));
  const [mode, setMode] = useState<SplitMode>('extract');
  const [ranges, setRanges] = useState('');
  const [every, setEvery] = useState(1);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);
  const [startError, setStartError] = useState<string | null>(null);

  const job = jobId ? jobs[jobId] : undefined;

  // ---- Adding files ----------------------------------------------------------------------
  const accept = useCallback(
    (result: InspectResult) => {
      const pdfs = result.files.filter((f) => f.format === 'pdf');
      const others = result.files.length - pdfs.length;
      const problems = [...result.rejected.map((r) => `${r.name}: ${r.error.message}`), ...(others > 0 ? [`${plural(others, 'file')} ${others === 1 ? 'is' : 'are'} not a PDF and ${others === 1 ? 'was' : 'were'} skipped.`] : [])];
      setNotice(problems.length > 0 ? problems.join(' ') : null);
      if (pdfs.length === 0) return;
      if (tab === 'merge') {
        setMerge((current) => [...current, ...pdfs.filter((f) => !current.some((c) => c.file.path === f.path)).map(entryOf)]);
      } else {
        const first = pdfs[0];
        if (first) setSplit(entryOf(first));
        if (pdfs.length > 1) setNotice('Only one PDF can be split at a time. The first one was used.');
      }
    },
    [tab],
  );

  const run = useCallback(
    async (load: () => Promise<InspectResult>) => {
      setBusy(true);
      try {
        accept(await load());
      } catch (cause) {
        setNotice(cause instanceof Error ? cause.message : 'The files could not be read.');
      } finally {
        setBusy(false);
      }
    },
    [accept],
  );

  useEffect(() => {
    registerDrop((files) => void run(() => api.inspectDroppedFiles(files)));
    return () => registerDrop(null);
  }, [api, registerDrop, run]);

  // ---- Starting --------------------------------------------------------------------------
  const start = async (request: StartPdfToolRequest) => {
    setStartError(null);
    try {
      const { jobId: id } = await api.startPdfTool(request);
      setJobId(id);
    } catch (cause) {
      setStartError(cause instanceof Error ? cause.message : 'The job could not be started.');
    }
  };

  const mergeKept = useMemo(() => merge.reduce((n, e) => n + e.keep.size, 0), [merge]);

  const startMerge = () =>
    void start({
      kind: 'merge',
      items: merge.map((e) => ({ fileId: e.file.id, ...(e.keep.size === pageCountOf(e.file) ? {} : { pages: sorted(e.keep) }) })),
    });

  const splitPlan = useMemo(() => {
    if (!split) return null;
    const chosen = split.keep.size;
    switch (mode) {
      case 'extract':
        return { files: chosen > 0 ? 1 : 0, text: chosen > 0 ? `${plural(chosen, 'page')} → one new PDF` : 'Choose at least one page.' };
      case 'each':
        return { files: chosen, text: chosen > 0 ? `${plural(chosen, 'page')} → ${plural(chosen, 'PDF')} (in a ZIP)` : 'Choose at least one page.' };
      case 'every': {
        const n = Math.max(1, every);
        const files = Math.ceil(chosen / n);
        return { files, text: chosen > 0 ? `${plural(chosen, 'page')} → ${plural(files, 'PDF')} of up to ${plural(n, 'page')} (in a ZIP)` : 'Choose at least one page.' };
      }
      case 'ranges': {
        const groups = ranges.split(',').filter((g) => g.trim() !== '').length;
        return { files: groups, text: groups > 0 ? `${plural(groups, 'part')} (in a ZIP unless there is only one)` : 'Type the page ranges, for example 1-3, 4-6, 7-.' };
      }
    }
  }, [split, mode, every, ranges]);

  const startSplit = () => {
    if (!split) return;
    const pages = mode === 'ranges' || split.keep.size === pageCountOf(split.file) ? {} : { pages: sorted(split.keep) };
    void start({
      kind: 'split',
      item: { fileId: split.file.id, ...pages },
      mode,
      ...(mode === 'ranges' ? { ranges } : {}),
      ...(mode === 'every' ? { every: Math.max(1, every) } : {}),
    });
  };

  const reset = () => {
    setJobId(null);
    setMerge([]);
    setSplit(null);
    setRanges('');
    setNotice(null);
    setStartError(null);
  };

  // ---- Result ----------------------------------------------------------------------------
  if (jobId) {
    return (
      <div className="space-y-3 px-4 pb-4">
        <ul aria-label="PDF job">
          {job && <JobRow job={job} onCancel={() => onCancel(job.id)} onOpen={() => onOpen(job.id)} onShow={() => onShow(job.id)} actionError={actionErrors[job.id] ?? null} />}
        </ul>
        {job && isFinished(job) && (
          <div className="flex justify-end">
            <Button variant="primary" onClick={reset}>
              Do something else
            </Button>
          </div>
        )}
      </div>
    );
  }

  const canMerge = merge.length >= 2 && mergeKept > 0 && merge.every((e) => e.keep.size > 0);
  const canSplit = !!splitPlan && splitPlan.files > 0 && (mode !== 'ranges' || /^[0-9,\-\s]+$/.test(ranges.trim()));

  return (
    <div className="px-4 pb-0">
      <div role="tablist" aria-label="PDF tool" className="no-drag mb-3 grid grid-cols-2 gap-1 rounded-xl border border-line bg-surface p-1">
        {(
          [
            ['merge', 'Merge PDFs', Merge],
            ['split', 'Split or extract', Scissors],
          ] as const
        ).map(([id, label, Icon]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            onClick={() => {
              setTab(id);
              setNotice(null);
            }}
            className={`flex h-8 items-center justify-center gap-1.5 rounded-lg text-[13px] transition-colors ${tab === id ? 'bg-raised font-medium text-ink' : 'text-muted hover:text-ink'}`}
          >
            <Icon size={14} aria-hidden /> {label}
          </button>
        ))}
      </div>

      {notice && (
        <div className="mb-3">
          <Notice tone="warn">{notice}</Notice>
        </div>
      )}

      {tab === 'merge' ? (
        <div className="space-y-3">
          {merge.length === 0 && <EmptyPicker busy={busy} text="Drop two or more PDFs here, or browse. Then drag the order with the arrows and untick pages you do not want." onBrowse={() => void run(() => api.pickFiles())} />}
          <ul className="space-y-3" aria-label="PDFs to merge">
            {merge.map((entry, index) => (
              <li key={entry.file.id} className="no-drag rounded-xl border border-line bg-surface p-3">
                <div className="mb-2 flex items-center gap-2">
                  <span className="grid size-5 shrink-0 place-items-center rounded-full bg-raised text-[11px] font-semibold tabular-nums text-muted">{index + 1}</span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[13px] font-medium text-ink" title={entry.file.path}>
                      {entry.file.name}
                    </p>
                    <p className="text-xs text-muted">
                      {entry.keep.size === pageCountOf(entry.file) ? plural(pageCountOf(entry.file), 'page') : `${entry.keep.size} of ${plural(pageCountOf(entry.file), 'page')} included`} · {formatBytes(entry.file.size)}
                    </p>
                  </div>
                  <IconButton label="Move up" disabled={index === 0} onClick={() => setMerge((m) => swap(m, index, index - 1))}>
                    <ArrowUp size={15} aria-hidden />
                  </IconButton>
                  <IconButton label="Move down" disabled={index === merge.length - 1} onClick={() => setMerge((m) => swap(m, index, index + 1))}>
                    <ArrowDown size={15} aria-hidden />
                  </IconButton>
                  <IconButton label={`Remove ${entry.file.name}`} onClick={() => setMerge((m) => m.filter((e) => e.file.id !== entry.file.id))}>
                    <X size={15} aria-hidden />
                  </IconButton>
                </div>
                <SelectionBar total={pageCountOf(entry.file)} keep={entry.keep} onChange={(keep) => setMerge((m) => m.map((e) => (e.file.id === entry.file.id ? { ...e, keep } : e)))} />
                <PageGrid
                  key={entry.file.id}
                  fileId={entry.file.id}
                  pageCount={pageCountOf(entry.file)}
                  selected={entry.keep}
                  onChange={(keep) => setMerge((m) => m.map((e) => (e.file.id === entry.file.id ? { ...e, keep } : e)))}
                />
              </li>
            ))}
          </ul>
          {merge.length > 0 && (
            <Button onClick={() => void run(() => api.pickFiles())} disabled={busy}>
              <FilePlus2 size={14} aria-hidden /> Add more PDFs
            </Button>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          {!split && <EmptyPicker busy={busy} text="Drop one PDF here, or browse. You will see every page and can pick the ones you need." onBrowse={() => void run(() => api.pickFiles())} />}
          {split && (
            <div className="no-drag rounded-xl border border-line bg-surface p-3">
              <div className="mb-3 flex items-center gap-2">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13px] font-medium text-ink" title={split.file.path}>
                    {split.file.name}
                  </p>
                  <p className="text-xs text-muted">
                    {plural(pageCountOf(split.file), 'page')} · {formatBytes(split.file.size)}
                  </p>
                </div>
                <Button onClick={() => void run(() => api.pickFiles())} disabled={busy}>
                  <FolderOpen size={14} aria-hidden /> Change
                </Button>
              </div>

              <fieldset className="mb-3 space-y-1.5">
                <legend className="mb-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-faint">What to do</legend>
                {(
                  [
                    ['extract', 'Extract the chosen pages', 'One new PDF with the pages you pick below'],
                    ['each', 'Save each chosen page separately', 'One PDF per page, in a ZIP'],
                    ['every', 'Cut into parts of equal size', 'For example every 10 pages'],
                    ['ranges', 'Split at page ranges', 'Type the parts, like 1-3, 4-6, 7-'],
                  ] as const
                ).map(([value, label, description]) => (
                  <label key={value} className="flex cursor-pointer items-start gap-2.5 text-[13px]">
                    <input type="radio" name="split-mode" className="mt-0.5 accent-[var(--color-accent)]" checked={mode === value} onChange={() => setMode(value)} />
                    <span>
                      <span className="text-ink">{label}</span>
                      <span className="block text-xs text-muted">{description}</span>
                    </span>
                  </label>
                ))}
              </fieldset>

              {mode === 'every' && (
                <label className="mb-3 flex items-center gap-2 text-[13px] text-ink">
                  Pages per part
                  <input type="number" min={1} max={10000} value={every} onChange={(e) => setEvery(Number(e.target.value) || 1)} className="h-8 w-20 rounded-lg border border-line bg-raised px-2 text-ink" />
                </label>
              )}
              {mode === 'ranges' && (
                <label className="mb-3 block text-[13px] text-ink">
                  Page ranges, separated by commas
                  <input
                    type="text"
                    value={ranges}
                    placeholder="1-3, 4-6, 7-"
                    onChange={(e) => setRanges(e.target.value.replace(/[^0-9,\-\s]/g, ''))}
                    className="mt-1 h-8 w-full rounded-lg border border-line bg-raised px-2 text-ink placeholder:text-faint"
                  />
                  <span className="mt-1 block text-xs text-muted">Each group becomes its own PDF. A trailing dash means “to the last page”.</span>
                </label>
              )}

              {mode !== 'ranges' && <SelectionBar total={pageCountOf(split.file)} keep={split.keep} onChange={(keep) => setSplit({ ...split, keep })} />}
              <PageGrid
                key={split.file.id}
                fileId={split.file.id}
                pageCount={pageCountOf(split.file)}
                selected={mode === 'ranges' ? new Set<number>() : split.keep}
                onChange={(keep) => mode !== 'ranges' && setSplit({ ...split, keep })}
              />
            </div>
          )}
        </div>
      )}

      {startError && (
        <div className="mt-3">
          <Notice tone="bad">{startError}</Notice>
        </div>
      )}

      <div className="sticky bottom-0 -mx-4 mt-3 flex items-center justify-between gap-3 border-t border-line bg-bg px-4 py-3">
        <p className="min-w-0 truncate text-xs text-muted" aria-live="polite">
          {tab === 'merge' ? (merge.length < 2 ? 'Add at least two PDFs.' : `${plural(merge.length, 'PDF')} · ${plural(mergeKept, 'page')} in the result`) : (splitPlan?.text ?? 'Add a PDF to begin.')}
        </p>
        {tab === 'merge' ? (
          <Button variant="primary" className="h-9 shrink-0 px-4" disabled={!canMerge} onClick={startMerge}>
            <Merge size={15} aria-hidden /> Merge
          </Button>
        ) : (
          <Button variant="primary" className="h-9 shrink-0 px-4" disabled={!canSplit} onClick={startSplit}>
            <Scissors size={15} aria-hidden /> {mode === 'extract' ? 'Extract' : 'Split'}
          </Button>
        )}
      </div>
    </div>
  );
}

function swap(list: PdfEntry[], a: number, b: number): PdfEntry[] {
  const next = [...list];
  const x = next[a];
  const y = next[b];
  if (!x || !y) return list;
  next[a] = y;
  next[b] = x;
  return next;
}

function SelectionBar({ total, keep, onChange }: { total: number; keep: ReadonlySet<number>; onChange: (keep: Set<number>) => void }) {
  return (
    <div className="no-drag mb-2 flex items-center justify-between gap-2 text-xs text-muted">
      <span>
        {keep.size} of {total} selected · click a page, Shift+click for a range
      </span>
      <span className="flex gap-1">
        <button type="button" className="rounded px-1.5 py-0.5 hover:bg-raised hover:text-ink" onClick={() => onChange(allPages(total))}>
          All
        </button>
        <button type="button" className="rounded px-1.5 py-0.5 hover:bg-raised hover:text-ink" onClick={() => onChange(new Set())}>
          None
        </button>
      </span>
    </div>
  );
}

function EmptyPicker({ text, onBrowse, busy }: { text: string; onBrowse: () => void; busy: boolean }) {
  return (
    <div className="no-drag grid place-items-center gap-3 rounded-xl border border-dashed border-line-strong px-6 py-8 text-center">
      <p className="max-w-[40ch] text-[13px] text-muted">{text}</p>
      <Button variant="primary" onClick={onBrowse} disabled={busy}>
        <FolderOpen size={14} aria-hidden /> {busy ? 'Reading…' : 'Browse PDFs'}
      </Button>
    </div>
  );
}
