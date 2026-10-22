// One study day in the schedule: editable focus and minutes (debounced PATCH
// of the whole schedule), and question chips that jump to the question.

import type { Question, ScheduleDay } from '@contracts';
import { EditableText } from './EditableText';
import { Chip, focusRing } from './primitives';
import { questionSnippet } from '../lib/labels';
import type { ScheduleDayPatch } from '../lib/mutations';

export interface DayCardProps {
  day: ScheduleDay;
  questions: Question[];
  onPatch: (patch: ScheduleDayPatch) => Promise<void>;
  onJumpToQuestion: (qid: string) => void;
}

export function DayCard({ day, questions, onPatch, onJumpToQuestion }: DayCardProps) {
  const byId = new Map(questions.map((q) => [q.id, q]));

  const saveMinutes = async (raw: string) => {
    const minutes = Number(raw);
    if (!Number.isFinite(minutes) || minutes < 0) return;
    await onPatch({ minutes: Math.round(minutes) });
  };

  return (
    <article
      aria-label={`Study day ${day.day}`}
      className="flex flex-col gap-3 rounded-xl border border-slate-800 bg-slate-900/60 p-4"
    >
      <div className="flex items-center gap-2.5">
        <span
          className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-indigo-500/15 text-sm font-semibold text-indigo-300"
          aria-hidden
        >
          {day.day}
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[11px] font-medium uppercase tracking-wide text-slate-500">
            Day {day.day} focus
          </p>
          <EditableText
            value={day.focus}
            label={`day ${day.day} focus`}
            onSave={(v) => onPatch({ focus: v })}
            rows={2}
            displayClassName="text-sm font-medium text-slate-200"
          />
        </div>
      </div>

      <div className="flex items-center justify-between gap-2 border-t border-slate-800 pt-2 text-xs text-slate-400">
        <span className="flex items-center gap-1">
          <EditableText
            value={String(day.minutes)}
            label={`day ${day.day} minutes`}
            onSave={saveMinutes}
            multiline={false}
            numeric
            displayClassName="text-xs font-medium text-slate-300"
          />
          <span>min</span>
        </span>
        <span>
          {day.question_ids.length} question{day.question_ids.length === 1 ? '' : 's'}
        </span>
      </div>

      {day.question_ids.length > 0 ? (
        <ul className="flex flex-wrap gap-1.5" aria-label={`Questions for day ${day.day}`}>
          {day.question_ids.map((qid) => {
            const q = byId.get(qid);
            return (
              <li key={qid}>
                <button
                  type="button"
                  onClick={() => onJumpToQuestion(qid)}
                  title={q ? `Show question ${qid}` : `Show question ${qid} (missing)`}
                  className={`max-w-xs truncate rounded-full border border-slate-700 bg-slate-800/60 px-2 py-0.5 text-left text-[11px] font-medium text-slate-300 transition-colors hover:border-indigo-400 hover:text-indigo-300 ${focusRing}`}
                >
                  {q ? questionSnippet(q.prompt, 40) : qid}
                </button>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="text-xs text-slate-500">No questions scheduled.</p>
      )}
    </article>
  );
}
