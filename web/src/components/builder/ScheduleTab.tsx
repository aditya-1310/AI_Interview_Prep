// Schedule tab: total study time, day cards with inline edits (debounced
// PATCH of the whole schedule), and "Regenerate schedule" with an optional new
// day count.

import { useState } from 'react';
import { CalendarDays } from 'lucide-react';
import type { KitRecordDoc } from '../../api/kits';
import { Chip, ConfirmButton, EmptyState, Field, TextInput } from '../primitives';
import { DayCard } from '../DayCard';
import type { KitMutations } from '../../lib/mutations';

export function ScheduleTab({
  record,
  m,
  regenBusy,
  onJumpToQuestion,
}: {
  record: KitRecordDoc;
  m: KitMutations;
  regenBusy: boolean;
  onJumpToQuestion: (qid: string) => void;
}) {
  const k = record.kit;
  const schedule = k?.schedule;
  const days = schedule?.days ?? [];
  const questions = k?.questions ?? [];
  const totalMinutes = days.reduce((sum, d) => sum + (d.minutes || 0), 0);
  const totalHours = Math.round((totalMinutes / 60) * 10) / 10;
  const [newDays, setNewDays] = useState('');

  const regenerate = () => {
    const parsed = Number(newDays);
    const dayCount =
      newDays.trim() !== '' && Number.isInteger(parsed) && parsed >= 1 && parsed <= 60
        ? parsed
        : undefined;
    m.regenerate('schedule', dayCount);
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-slate-800 bg-slate-900/60 px-4 py-3">
        <Chip className="border-indigo-500/50 bg-indigo-500/15 text-indigo-300">
          <CalendarDays className="h-3 w-3" aria-hidden />
          {schedule?.days_available ?? days.length} day plan
        </Chip>
        <Chip>
          {totalMinutes} min total
          {totalHours >= 1 ? ` (~${totalHours} h)` : ''}
        </Chip>
        <div className="ml-auto flex flex-wrap items-end gap-2">
          <div className="w-36">
            <Field id="schedule-days" label="New day count (optional)" hint="1–60">
              <TextInput
                id="schedule-days"
                type="number"
                min={1}
                max={60}
                value={newDays}
                onChange={(e) => setNewDays(e.target.value)}
                placeholder="e.g. 10"
              />
            </Field>
          </div>
          <ConfirmButton
            label="Regenerate schedule"
            confirmLabel="Rebuild schedule?"
            note="Reallocates all questions across the days. Manual day edits are replaced; questions themselves are kept."
            size="md"
            onConfirm={regenerate}
            disabled={regenBusy}
          />
        </div>
      </div>

      {days.length === 0 ? (
        <EmptyState
          icon={CalendarDays}
          title="No schedule yet"
          description="Regenerate the schedule to distribute the questions across your available days."
        />
      ) : (
        <ol className="grid gap-4 lg:grid-cols-2">
          {days.map((day) => (
            <li key={day.day}>
              <DayCard
                day={day}
                questions={questions}
                onPatch={(patch) => m.patchScheduleDay(day.day, patch)}
                onJumpToQuestion={onJumpToQuestion}
              />
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
