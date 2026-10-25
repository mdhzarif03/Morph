import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { Header } from './components/Header';
import { Home } from './components/Home';
import { SettingsView } from './components/SettingsView';
import { PdfTools } from './components/pdf/PdfTools';
import { Notice } from './components/ui';
import { getApi } from './lib/api';
import { commonTargets, initialState, isFinished, reducer } from './lib/state';
import type { Settings } from '../shared/settings';
import type { InspectedFile, ShortcutStatus } from '../shared/types';

export function App() {
  const api = getApi();
  const [state, dispatch] = useReducer(reducer, initialState);
  const [dragging, setDragging] = useState(false);
  const [actionErrors, setActionErrors] = useState<Record<string, string>>({});
  const [shortcut, setShortcut] = useState<ShortcutStatus | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  // Light and Dark are applied directly; System leaves the attribute off so the page follows Windows.
  useEffect(() => {
    const theme = settings?.theme;
    if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
    else delete document.documentElement.dataset.theme;
  }, [settings?.theme]);
  const shellRef = useRef<HTMLDivElement>(null);
  const dragDepth = useRef(0);
  const viewRef = useRef(state.view);
  viewRef.current = state.view;
  const jobsRef = useRef(state.jobs);
  jobsRef.current = state.jobs;
  // Bumped whenever the popup starts over, so screens that keep their own state (PDF tools) start fresh too.
  const [session, setSession] = useState(0);
  const [pdfSeed, setPdfSeed] = useState<InspectedFile[]>([]);
  const pdfDrop = useRef<((files: File[]) => void) | null>(null);
  const registerPdfDrop = useCallback((handler: ((files: File[]) => void) | null) => {
    pdfDrop.current = handler;
  }, []);

  const targets = useMemo(() => commonTargets(state.files), [state.files]);

  // ---- Main-process events ---------------------------------------------------------------
  useEffect(() => {
    void api.listJobs().then((jobs) => dispatch({ type: 'jobs-loaded', jobs }));
    void api.getShortcutStatus().then(setShortcut);
    void api.getSettings().then(setSettings);
    const offJobs = api.onJobUpdated((job) => dispatch({ type: 'job-updated', job }));
    const offNav = api.onNavigate((view) => dispatch({ type: 'navigate', view }));
    // Closing the popup ends the visit: the next time it opens it shows the first page again.
    // Work that is still running is never thrown away.
    const startOver = () => {
      if (Object.values(jobsRef.current).some((job) => !isFinished(job))) return;
      void api.clearFinished();
      dispatch({ type: 'start-over' });
      setActionErrors({});
      setPdfSeed([]);
      setSession((n) => n + 1);
    };
    const offHidden = api.onWindowHidden(startOver);
    const offShown = api.onWindowShown((info) => {
      if (info.fresh) startOver();
      if (info.view) dispatch({ type: 'navigate', view: info.view });
    });
    const offShortcut = api.onShortcutStatusChanged(setShortcut);
    return () => {
      offJobs();
      offNav();
      offShortcut();
      offHidden();
      offShown();
    };
  }, [api]);

  // Refresh cached settings/shortcut whenever the popup is shown or settings close.
  useEffect(() => {
    const refresh = () => {
      void api.getShortcutStatus().then(setShortcut);
      void api.getSettings().then(setSettings);
    };
    const off = api.onWindowShown(refresh);
    if (state.view === 'home') refresh();
    return off;
  }, [api, state.view]);

  // ---- Size the popup to its content -----------------------------------------------------
  useEffect(() => {
    const el = shellRef.current;
    if (!el) return;
    const report = () => void api.setContentHeight(el.getBoundingClientRect().height);
    const observer = new ResizeObserver(report);
    observer.observe(el);
    report();
    return () => observer.disconnect();
  }, [api]);

  // ---- Files -----------------------------------------------------------------------------
  const inspectWith = useCallback(
    async (load: () => ReturnType<typeof api.pickFiles>) => {
      dispatch({ type: 'inspect-start' });
      try {
        const result = await load();
        dispatch({ type: 'inspect-done', files: result.files, rejected: result.rejected, add: true });
      } catch (error) {
        dispatch({
          type: 'inspect-done',
          files: [],
          rejected: [{ name: 'Files', path: 'error', error: { code: 'INTERNAL', message: error instanceof Error ? error.message : 'The files could not be read.' } }],
          add: true,
        });
      }
    },
    [api],
  );

  const browse = useCallback(() => void inspectWith(() => api.pickFiles()), [api, inspectWith]);

  // ---- Window-level drag and drop (also stops Electron from navigating to a dropped file) ---
  useEffect(() => {
    const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files');
    const onEnter = (e: DragEvent) => {
      e.preventDefault();
      if (!hasFiles(e)) return;
      dragDepth.current += 1;
      setDragging(true);
    };
    const onOver = (e: DragEvent) => {
      e.preventDefault();
      if (e.dataTransfer && hasFiles(e)) e.dataTransfer.dropEffect = 'copy';
    };
    const onLeave = (e: DragEvent) => {
      e.preventDefault();
      dragDepth.current = Math.max(0, dragDepth.current - 1);
      if (dragDepth.current === 0) setDragging(false);
    };
    const onDrop = (e: DragEvent) => {
      e.preventDefault();
      dragDepth.current = 0;
      setDragging(false);
      const files = Array.from(e.dataTransfer?.files ?? []);
      if (files.length === 0) return;
      if (viewRef.current === 'home') void inspectWith(() => api.inspectDroppedFiles(files));
      else if (viewRef.current === 'pdf') pdfDrop.current?.(files);
    };
    window.addEventListener('dragenter', onEnter);
    window.addEventListener('dragover', onOver);
    window.addEventListener('dragleave', onLeave);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragenter', onEnter);
      window.removeEventListener('dragover', onOver);
      window.removeEventListener('dragleave', onLeave);
      window.removeEventListener('drop', onDrop);
    };
  }, [api, inspectWith]);

  // ---- Keyboard: Escape dismisses; Enter on the page starts a ready conversion ------------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      if (viewRef.current !== 'home') dispatch({ type: 'navigate', view: 'home' });
      else void api.hideWindow();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [api]);

  // ---- Conversion ------------------------------------------------------------------------
  const convert = useCallback(async () => {
    if (!state.target) return;
    const descriptor = targets.find((t) => t.format === state.target);
    const allowed = new Set(descriptor?.options.map((s) => s.key));
    const options = Object.fromEntries(Object.entries(state.options).filter(([key]) => allowed.has(key)));
    try {
      const response = await api.startConversion({ fileIds: state.files.map((f) => f.id), target: state.target, options });
      const rejectedText = response.rejected.map((r) => r.error.message);
      dispatch({ type: 'jobs-started', jobIds: response.jobIds, startError: rejectedText.length > 0 ? rejectedText.join(' ') : null });
    } catch (error) {
      dispatch({ type: 'jobs-started', jobIds: [], startError: error instanceof Error ? error.message : 'The conversion could not be started.' });
    }
  }, [api, state.files, state.options, state.target, targets]);

  const runOutputAction = useCallback(
    async (jobId: string, action: 'open' | 'show') => {
      try {
        const result = await (action === 'open' ? api.openOutput(jobId) : api.showOutput(jobId));
        setActionErrors((prev) => ({ ...prev, [jobId]: result.ok ? '' : (result.message ?? 'That did not work.') }));
      } catch (error) {
        setActionErrors((prev) => ({ ...prev, [jobId]: error instanceof Error ? error.message : 'That did not work.' }));
      }
    },
    [api],
  );

  const reset = useCallback(() => {
    void api.clearFinished();
    dispatch({ type: 'reset' });
    setActionErrors({});
  }, [api]);

  const anyActive = state.jobIds.some((id) => !isFinished(state.jobs[id]));
  const shortcutProblem = shortcut && !shortcut.registered;

  return (
    <div ref={shellRef} className="w-full">
      <Header
        view={state.view}
        shortcut={shortcut?.registered ? shortcut.accelerator : null}
        onSettings={() => dispatch({ type: 'navigate', view: 'settings' })}
        onPdfTools={() => {
          setPdfSeed(state.files.filter((f) => f.format === 'pdf'));
          setSession((n) => n + 1);
          dispatch({ type: 'navigate', view: 'pdf' });
        }}
        onBack={() => dispatch({ type: 'navigate', view: 'home' })}
        onClose={() => void api.hideWindow()}
      />
      <main className="overflow-y-auto" style={{ maxHeight: 'calc(var(--avail, 800px) * 0.86 - 64px)' }}>
        {state.view === 'home' && shortcutProblem && (
          <div className="px-4 pb-2">
            <Notice tone="warn">
              The shortcut <strong>{shortcut.accelerator.split('+').join(' + ')}</strong> is not active. {shortcut.problem ?? ''}{' '}
              <button type="button" className="underline underline-offset-2" onClick={() => dispatch({ type: 'navigate', view: 'settings' })}>
                Choose another
              </button>
            </Notice>
          </div>
        )}
        {state.view === 'home' ? (
          <Home
            state={state}
            targets={targets}
            dragging={dragging}
            actionErrors={actionErrors}
            onBrowse={browse}
            onRemove={(file) => dispatch({ type: 'remove-file', id: file.id })}
            onSelectTarget={(format) => dispatch({ type: 'select-target', target: format })}
            onOption={(key, value) => dispatch({ type: 'set-option', key, value })}
            onConvert={() => void convert()}
            onCancel={(id) => void api.cancelJob(id)}
            onCancelAll={() => void api.cancelAll()}
            onOpen={(id) => void runOutputAction(id, 'open')}
            onShow={(id) => void runOutputAction(id, 'show')}
            onReset={anyActive ? () => void api.cancelAll().then(reset) : reset}
          />
        ) : state.view === 'pdf' ? (
          <PdfTools
            key={session}
            jobs={state.jobs}
            seedFiles={pdfSeed}
            actionErrors={actionErrors}
            registerDrop={registerPdfDrop}
            onCancel={(id) => void api.cancelJob(id)}
            onOpen={(id) => void runOutputAction(id, 'open')}
            onShow={(id) => void runOutputAction(id, 'show')}
          />
        ) : (
          <SettingsView settings={settings} onSettings={setSettings} shortcut={shortcut} onShortcut={setShortcut} />
        )}
      </main>
    </div>
  );
}
