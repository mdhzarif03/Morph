import { ArrowRight, Plus } from 'lucide-react';
import type { InspectedFile, JobSnapshot, RejectedFile, TargetDescriptor } from '../../shared/types';
import type { OptionValue } from '../../shared/options';
import type { FormatId } from '../../shared/formats';
import { activeSpecs, isFinished, type AppState } from '../lib/state';
import { plural } from '../lib/format';
import { DropZone } from './DropZone';
import { FileCard } from './FileCard';
import { JobRow } from './JobRow';
import { OptionsPanel } from './OptionsPanel';
import { TargetPicker } from './TargetPicker';
import { Button, Notice } from './ui';

interface Props {
  state: AppState;
  targets: TargetDescriptor[];
  dragging: boolean;
  actionErrors: Record<string, string>;
  onBrowse: () => void;
  onRemove: (file: InspectedFile) => void;
  onSelectTarget: (format: FormatId) => void;
  onOption: (key: string, value: OptionValue) => void;
  onConvert: () => void;
  onCancel: (jobId: string) => void;
  onCancelAll: () => void;
  onOpen: (jobId: string) => void;
  onShow: (jobId: string) => void;
  onReset: () => void;
}

function Rejected({ items }: { items: RejectedFile[] }) {
  if (items.length === 0) return null;
  return (
    <div className="space-y-1.5">
      {items.map((item) => (
        <Notice key={item.path} tone="bad">
          <strong className="font-semibold">{item.name}</strong> — {item.error.message}
        </Notice>
      ))}
    </div>
  );
}

export function Home(props: Props) {
  const { state, targets, dragging } = props;
  const jobs = state.jobIds.map((id) => state.jobs[id]).filter((j): j is JobSnapshot => j !== undefined);
  const converting = state.jobIds.length > 0;
  const allFinished = converting && jobs.length > 0 && jobs.every((j) => isFinished(j));
  const activeCount = jobs.filter((j) => !isFinished(j)).length;

  if (state.files.length === 0 && !converting) {
    return (
      <div className="space-y-3 px-4 pb-4">
        <DropZone dragging={dragging} busy={state.inspecting} onBrowse={props.onBrowse} />
        <Rejected items={state.rejected} />
      </div>
    );
  }

  if (converting) {
    const done = jobs.filter((j) => j.status === 'succeeded').length;
    return (
      <div className="space-y-3 px-4 pb-4">
        <ul className="space-y-2" aria-label="Conversions">
          {jobs.map((job) => (
            <JobRow key={job.id} job={job} onCancel={() => props.onCancel(job.id)} onOpen={() => props.onOpen(job.id)} onShow={() => props.onShow(job.id)} actionError={props.actionErrors[job.id] ?? null} />
          ))}
        </ul>
        {state.startError && <Notice tone="bad">{state.startError}</Notice>}
        <div className="flex items-center justify-between gap-2">
          <p className="text-xs text-muted" aria-live="polite">
            {allFinished ? `${done} of ${plural(jobs.length, 'file')} converted` : `${plural(activeCount, 'file')} in progress`}
          </p>
          {allFinished ? (
            <Button variant="primary" onClick={props.onReset}>
              <Plus size={14} aria-hidden /> Convert another
            </Button>
          ) : (
            activeCount > 1 && <Button onClick={props.onCancelAll}>Cancel all</Button>
          )}
        </div>
      </div>
    );
  }

  const target = targets.find((t) => t.format === state.target) ?? null;
  const specs = target ? activeSpecs(target.options, state.options) : [];
  const batch = state.files.length > 1;

  return (
    <div className="space-y-3.5 px-4 pb-4">
      <ul className="max-h-[calc(var(--avail,800px)*0.22)] space-y-2 overflow-y-auto pr-0.5" aria-label="Selected files">
        {state.files.map((file) => (
          <FileCard key={file.id} file={file} removable onRemove={() => props.onRemove(file)} />
        ))}
      </ul>
      <Rejected items={state.rejected} />

      <div>
        <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-faint">Convert {batch ? `${state.files.length} files` : ''} to</p>
        <TargetPicker targets={targets} selected={state.target} onSelect={props.onSelectTarget} />
      </div>

      {target && (
        <div className="space-y-3 animate-fade-in">
          {target.notes.map((note) => (
            <p key={note} className="text-xs text-muted">
              {note}
            </p>
          ))}
          {specs.length > 0 && <OptionsPanel specs={target.options} values={state.options} onChange={props.onOption} />}
        </div>
      )}

      {batch && targets.length === 0 && <Notice tone="warn">These files have no conversion in common. Remove some, or convert them one kind at a time.</Notice>}
      {state.startError && <Notice tone="bad">{state.startError}</Notice>}

      <DropZone dragging={dragging} busy={state.inspecting} compact onBrowse={props.onBrowse} />

      <div className="flex items-center justify-between gap-2">
        <Button variant="ghost" onClick={props.onReset}>
          Clear
        </Button>
        <Button variant="primary" className="h-9 px-4" disabled={!target || !target.available} onClick={props.onConvert}>
          Convert {batch ? `${state.files.length} files` : ''}
          <ArrowRight size={15} aria-hidden />
        </Button>
      </div>
    </div>
  );
}
