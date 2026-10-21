import { defaultOptions, isOptionActive, type OptionSpec, type OptionValue, type OptionValues } from '../../shared/options';
import type { FormatId } from '../../shared/formats';
import type { InspectedFile, JobSnapshot, RejectedFile, TargetDescriptor } from '../../shared/types';

export type View = 'home' | 'settings';

export interface AppState {
  view: View;
  files: InspectedFile[];
  rejected: RejectedFile[];
  target: FormatId | null;
  options: OptionValues;
  /** Jobs started from the current file list, in start order. */
  jobIds: string[];
  jobs: Record<string, JobSnapshot>;
  inspecting: boolean;
  /** Set when starting a conversion failed before any job existed. */
  startError: string | null;
}

export const initialState: AppState = {
  view: 'home',
  files: [],
  rejected: [],
  target: null,
  options: {},
  jobIds: [],
  jobs: {},
  inspecting: false,
  startError: null,
};

export type Action =
  | { type: 'navigate'; view: View }
  | { type: 'inspect-start' }
  | { type: 'inspect-done'; files: InspectedFile[]; rejected: RejectedFile[]; add: boolean }
  | { type: 'remove-file'; id: string }
  | { type: 'select-target'; target: FormatId }
  | { type: 'set-option'; key: string; value: OptionValue }
  | { type: 'jobs-started'; jobIds: string[]; startError: string | null }
  | { type: 'job-updated'; job: JobSnapshot }
  | { type: 'jobs-loaded'; jobs: JobSnapshot[] }
  | { type: 'reset' };

/** Targets that every selected file can be converted to (batch conversions need a common format). */
export function commonTargets(files: readonly InspectedFile[]): TargetDescriptor[] {
  const first = files[0];
  if (!first) return [];
  return first.targets
    .filter((target) => files.every((file) => file.targets.some((t) => t.format === target.format)))
    .map((target) => {
      // A target is usable only if it is available for every file.
      const everywhere = files.every((file) => file.targets.find((t) => t.format === target.format)?.available);
      if (everywhere) return target;
      const blocked = files.map((f) => f.targets.find((t) => t.format === target.format)).find((t) => t && !t.available);
      return { ...target, available: false, unavailableReason: blocked?.unavailableReason ?? 'Not available for every selected file.' };
    });
}

export function activeSpecs(specs: readonly OptionSpec[], values: OptionValues): OptionSpec[] {
  return specs.filter((spec) => isOptionActive(spec, values));
}

export function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case 'navigate':
      return { ...state, view: action.view };
    case 'inspect-start':
      return { ...state, inspecting: true };
    case 'inspect-done': {
      const merged = action.add ? [...state.files, ...action.files.filter((f) => !state.files.some((e) => e.path === f.path))] : action.files;
      const keepTarget = state.target && commonTargets(merged).some((t) => t.format === state.target && t.available);
      const finishedPrevious = state.jobIds.length > 0 && state.jobIds.every((id) => isFinished(state.jobs[id]));
      const base = finishedPrevious || !action.add ? { ...state, jobIds: [] as string[] } : state;
      return {
        ...base,
        inspecting: false,
        files: merged,
        rejected: action.rejected,
        startError: null,
        target: keepTarget ? state.target : null,
        options: keepTarget ? state.options : {},
      };
    }
    case 'remove-file': {
      const files = state.files.filter((f) => f.id !== action.id);
      const keepTarget = state.target && commonTargets(files).some((t) => t.format === state.target && t.available);
      return { ...state, files, target: keepTarget ? state.target : null, options: keepTarget ? state.options : {} };
    }
    case 'select-target': {
      const descriptor = commonTargets(state.files).find((t) => t.format === action.target);
      return { ...state, target: action.target, options: descriptor ? defaultOptions(descriptor.options) : {}, startError: null };
    }
    case 'set-option':
      return { ...state, options: { ...state.options, [action.key]: action.value } };
    case 'jobs-started':
      return { ...state, jobIds: action.jobIds, startError: action.startError };
    case 'job-updated':
      return { ...state, jobs: { ...state.jobs, [action.job.id]: action.job } };
    case 'jobs-loaded':
      return { ...state, jobs: { ...state.jobs, ...Object.fromEntries(action.jobs.map((j) => [j.id, j])) } };
    case 'reset':
      return { ...initialState, view: state.view, jobs: state.jobs };
  }
}

export function isFinished(job: JobSnapshot | undefined): boolean {
  return job !== undefined && (job.status === 'succeeded' || job.status === 'failed' || job.status === 'cancelled');
}
