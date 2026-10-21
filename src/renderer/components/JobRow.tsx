import { Ban, ChevronDown, CircleAlert, CircleCheck, ExternalLink, FolderOpen, X } from 'lucide-react';
import { useState } from 'react';
import { FORMATS } from '../../shared/formats';
import type { JobSnapshot } from '../../shared/types';
import { formatBytes, middleEllipsis } from '../lib/format';
import { Button, IconButton, Notice, Spinner } from './ui';

function ProgressBar({ progress, label }: { progress: number | null; label: string }) {
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      {...(progress === null ? {} : { 'aria-valuenow': Math.round(progress * 100) })}
      className="relative h-1.5 overflow-hidden rounded-full bg-raised"
    >
      {progress === null ? (
        <div className="absolute inset-y-0 w-2/5 animate-indeterminate rounded-full bg-accent" />
      ) : (
        <div className="h-full rounded-full bg-accent transition-[width] duration-150" style={{ width: `${Math.max(2, progress * 100)}%` }} />
      )}
    </div>
  );
}

interface Props {
  job: JobSnapshot;
  onCancel: () => void;
  onOpen: () => void;
  onShow: () => void;
  actionError: string | null;
}

export function JobRow({ job, onCancel, onOpen, onShow, actionError }: Props) {
  const [showDetail, setShowDetail] = useState(false);
  const target = FORMATS[job.targetFormat].label;
  const active = job.status === 'queued' || job.status === 'running' || job.status === 'finalizing';
  const output = job.outputs[0];

  return (
    <li className="no-drag rounded-xl border border-line bg-surface p-3 animate-fade-in">
      <div className="flex items-start gap-2.5">
        <div className="mt-0.5 shrink-0">
          {active && <Spinner className="mt-0.5" />}
          {job.status === 'succeeded' && <CircleCheck size={16} className="text-ok" aria-hidden />}
          {job.status === 'failed' && <CircleAlert size={16} className="text-bad" aria-hidden />}
          {job.status === 'cancelled' && <Ban size={16} className="text-muted" aria-hidden />}
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px] font-medium text-ink" title={job.sourcePath}>
            {middleEllipsis(job.sourceName, 40)} <span className="font-normal text-muted">→ {target}</span>
          </p>
          {active && (
            <div className="mt-2">
              <ProgressBar progress={job.status === 'finalizing' ? 1 : job.progress} label={`Converting ${job.sourceName}`} />
              <p className="mt-1.5 text-xs text-muted" aria-live="polite">
                {job.phase ?? 'Working'}
                {job.progress !== null && job.status === 'running' ? ` · ${Math.round(job.progress * 100)}%` : ''}
              </p>
            </div>
          )}
          {job.status === 'succeeded' && output && (
            <p className="mt-0.5 truncate text-xs text-muted" title={output.path}>
              Saved as <span className="text-ink">{output.name}</span> · {formatBytes(output.size)}
            </p>
          )}
          {job.status === 'succeeded' && output && (
            <p className="truncate text-xs text-faint" title={output.path}>
              {output.path}
            </p>
          )}
          {job.status === 'cancelled' && <p className="mt-0.5 text-xs text-muted">Cancelled. No files were changed.</p>}
          {job.status === 'failed' && job.error && (
            <div className="mt-1">
              <p className="text-xs text-bad">{job.error.message}</p>
              {job.error.detail && (
                <>
                  <button type="button" onClick={() => setShowDetail((v) => !v)} className="mt-1 inline-flex items-center gap-1 text-xs text-muted hover:text-ink" aria-expanded={showDetail}>
                    <ChevronDown size={12} className={showDetail ? 'rotate-180' : ''} aria-hidden /> Technical details
                  </button>
                  {showDetail && <pre className="mt-1 max-h-28 overflow-auto whitespace-pre-wrap rounded-lg bg-raised p-2 font-mono text-[11px] text-muted select-text">{job.error.detail}</pre>}
                </>
              )}
            </div>
          )}
        </div>
        {(job.status === 'queued' || job.status === 'running') && (
          <IconButton label={`Cancel conversion of ${job.sourceName}`} onClick={onCancel} disabled={job.cancelRequested}>
            <X size={15} aria-hidden />
          </IconButton>
        )}
      </div>

      {job.warnings.length > 0 && job.status !== 'failed' && (
        <div className="mt-2.5 space-y-1.5">
          {job.warnings.map((w) => (
            <Notice key={w} tone="warn">
              {w}
            </Notice>
          ))}
        </div>
      )}

      {job.status === 'succeeded' && (
        <div className="mt-3 flex flex-wrap gap-2">
          <Button variant="primary" onClick={onOpen}>
            <ExternalLink size={14} aria-hidden /> Open
          </Button>
          <Button onClick={onShow}>
            <FolderOpen size={14} aria-hidden /> Show in folder
          </Button>
        </div>
      )}
      {actionError && (
        <div className="mt-2">
          <Notice tone="bad">{actionError}</Notice>
        </div>
      )}
    </li>
  );
}
