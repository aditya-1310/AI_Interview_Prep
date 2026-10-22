// Step timeline for the generation pipeline. Steps come from the contract's
// stage names; a step is done when a later stage has been reached, running
// when it is the latest observed stage, pending otherwise. The latest
// progress message is announced politely.

import {
  CircleCheckBig,
  CircleX,
  LoaderCircle,
} from 'lucide-react';
import type { JobState } from '../api/kits';

export const PIPELINE_STEPS: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'extract', label: 'Extract requirements from the job description' },
  { id: 'crawl', label: 'Crawl the company site' },
  { id: 'discussion', label: 'Find public discussion of their interviews' },
  { id: 'brief', label: 'Draft the company brief' },
  { id: 'questions', label: 'Generate questions' },
  { id: 'coverage', label: 'Check coverage and close gaps' },
  { id: 'flashcards', label: 'Create flashcards' },
  { id: 'schedule', label: 'Build the study schedule' },
  { id: 'validate', label: 'Validate and save the kit' },
];

export function latestProgressMessage(job: JobState | null): string {
  const progress = job?.progress;
  if (progress && progress.length > 0) return progress[progress.length - 1].message;
  return 'Waiting for the job to start…';
}

export function isJobRunning(job: JobState | null): boolean {
  return job?.status === 'queued' || job?.status === 'running';
}

type StepState = 'done' | 'running' | 'error' | 'pending';

export function ProgressTimeline({ job }: { job: JobState | null }) {
  const progress = job?.progress ?? [];
  const stepIndex = (id: string) => PIPELINE_STEPS.findIndex((s) => s.id === id);
  let currentIdx = -1;
  for (const entry of progress) {
    const i = stepIndex(entry.step);
    if (i > currentIdx) currentIdx = i;
  }
  const completed = job?.status === 'completed';
  const failed = job?.status === 'failed';
  const running = isJobRunning(job);

  const stateFor = (i: number): StepState => {
    if (completed) return 'done';
    if (i < currentIdx) return 'done';
    if (i === currentIdx) return failed ? 'error' : 'running';
    return 'pending';
  };

  return (
    <div>
      <ol className="space-y-1" aria-label="Generation progress">
        {PIPELINE_STEPS.map((step, i) => {
          const state = stateFor(i);
          return (
            <li
              key={step.id}
              className={`flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm ${
                state === 'running' ? 'bg-indigo-500/10 text-indigo-200' : 'text-slate-300'
              }`}
            >
              {state === 'done' ? (
                <CircleCheckBig className="h-4 w-4 shrink-0 text-emerald-400" aria-hidden />
              ) : state === 'running' ? (
                <LoaderCircle className="h-4 w-4 shrink-0 animate-spin text-indigo-300" aria-hidden />
              ) : state === 'error' ? (
                <CircleX className="h-4 w-4 shrink-0 text-rose-400" aria-hidden />
              ) : (
                <span
                  className="ml-0.5 mr-0.5 inline-block h-2.5 w-2.5 shrink-0 rounded-full border-2 border-slate-700"
                  aria-hidden
                />
              )}
              <span className="min-w-0">{step.label}</span>
              {state === 'running' ? (
                <span className="ml-auto shrink-0 text-xs text-indigo-300">working…</span>
              ) : null}
            </li>
          );
        })}
      </ol>
      <p
        className="mt-4 flex items-start gap-2.5 rounded-xl border border-slate-800 bg-slate-900/60 px-4 py-3 text-sm text-slate-300"
        aria-live="polite"
        role="status"
      >
        {running ? (
          <LoaderCircle className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-indigo-300" aria-hidden />
        ) : null}
        <span className="min-w-0 break-words">{latestProgressMessage(job)}</span>
      </p>
    </div>
  );
}
