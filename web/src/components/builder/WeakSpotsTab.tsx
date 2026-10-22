// Weak spots (creative feature, fully client-side): ranks requirements by
// practice weakness — uncovered first, then lowest average flashcard
// confidence (unpracticed cards count as 0) — and links straight into a
// focused practice session.

import { Link } from 'react-router-dom';
import { GraduationCap, Target } from 'lucide-react';
import type { KitRecordDoc } from '../../api/kits';
import { Chip, EmptyState, focusRing } from '../primitives';
import { practiceTotals, rankWeakSpots } from '../../lib/weakSpots';
import { KIND_LABELS } from '../../lib/labels';

export function WeakSpotsTab({
  record,
  kitId,
}: {
  record: KitRecordDoc;
  kitId: string;
}) {
  const k = record.kit;
  const practice = record.practice ?? {};
  const spots = rankWeakSpots(k, practice);
  const totals = practiceTotals(k, practice);
  const uncoveredCount = spots.filter((s) => s.uncovered).length;
  const neverPracticed = totals.totalCards - totals.practicedCards;

  if (spots.length === 0) {
    return (
      <EmptyState
        icon={Target}
        title="No requirements to track"
        description="This kit has no extracted requirements, so there is nothing to rank yet."
      />
    );
  }

  return (
    <div className="space-y-4">
      <section className="flex flex-wrap items-center gap-3 rounded-xl border border-slate-800 bg-slate-900/60 px-4 py-3">
        <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400">
          <Chip>
            Cards practiced {totals.practicedCards}/{totals.totalCards}
          </Chip>
          {totals.avgConfidence !== null ? (
            <Chip>Average confidence {totals.avgConfidence.toFixed(1)}/3</Chip>
          ) : (
            <Chip>No practice yet</Chip>
          )}
          <Chip
            className={
              uncoveredCount > 0
                ? 'border-rose-500/50 bg-rose-500/15 text-rose-300'
                : 'border-emerald-500/50 bg-emerald-500/15 text-emerald-300'
            }
          >
            {uncoveredCount} uncovered must-have{uncoveredCount === 1 ? '' : 's'}
          </Chip>
          {neverPracticed > 0 ? (
            <Chip className="border-amber-500/50 bg-amber-500/15 text-amber-300">
              {neverPracticed} card{neverPracticed === 1 ? '' : 's'} never practiced
            </Chip>
          ) : null}
        </div>
        <Link
          to={`/kits/${kitId}/practice`}
          className={`ml-auto inline-flex items-center gap-1.5 rounded-lg bg-indigo-500 px-3.5 py-2 text-sm font-medium text-white transition-colors hover:bg-indigo-400 ${focusRing}`}
        >
          <GraduationCap className="h-4 w-4" aria-hidden />
          Start practice
        </Link>
      </section>

      <p className="text-xs text-slate-500">
        Ranked weakest first: uncovered requirements, then lowest average flashcard confidence
        (cards never practiced count as zero), then must-haves.
      </p>

      <ol className="space-y-2.5" aria-label="Weak spots, ranked">
        {spots.map((spot, i) => (
          <li
            key={spot.requirementId}
            className={`flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border bg-slate-900/60 px-4 py-3 ${
              spot.uncovered ? 'border-rose-500/40' : 'border-slate-800'
            }`}
          >
            <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-slate-800 text-xs font-semibold text-slate-400" aria-hidden>
              {i + 1}
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-sm text-slate-200">
                <span className="mr-1.5 font-mono text-xs text-slate-500">{spot.requirementId}</span>
                {spot.requirementText}
              </p>
              <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                <Chip
                  className={
                    spot.priority === 'must'
                      ? 'border-indigo-500/50 bg-indigo-500/15 text-indigo-300'
                      : undefined
                  }
                >
                  {spot.priority === 'must' ? 'Must-have' : 'Nice-to-have'}
                </Chip>
                <Chip>{KIND_LABELS[spot.kind as keyof typeof KIND_LABELS] ?? spot.kind}</Chip>
                {spot.uncovered ? (
                  <Chip className="border-rose-500/50 bg-rose-500/15 text-rose-300">
                    Uncovered — no question
                  </Chip>
                ) : (
                  <Chip className="border-emerald-500/40 bg-emerald-500/10 text-emerald-300">
                    {spot.questionCount} question{spot.questionCount === 1 ? '' : 's'}
                  </Chip>
                )}
                <Chip>
                  Cards practiced {spot.practicedCount}/{spot.cardCount}
                </Chip>
                <Chip>
                  {spot.avgConfidence === null
                    ? 'No cards'
                    : `Avg confidence ${spot.avgConfidence.toFixed(1)}/3`}
                </Chip>
              </div>
            </div>
            {spot.cardCount > 0 ? (
              <Link
                to={`/kits/${kitId}/practice?req=${encodeURIComponent(spot.requirementId)}`}
                className={`shrink-0 rounded-lg border border-slate-700 px-2.5 py-1.5 text-xs font-medium text-indigo-300 transition-colors hover:border-indigo-400 hover:text-indigo-200 ${focusRing}`}
              >
                Practice these
              </Link>
            ) : null}
          </li>
        ))}
      </ol>
    </div>
  );
}
