// Flashcard trainer: one card at a time, front first. Click the card (or
// press Space/Enter) to reveal the back, then rate confidence 1/2/3 (buttons
// or number keys) which POSTs and advances. Session order: never-practiced
// cards first, then ascending confidence, then least-recently-practiced; a
// ?req= link from the Weak spots tab front-loads that requirement's cards.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { ArrowLeft, Check, GraduationCap, Layers } from 'lucide-react';
import { errMessage } from '../api/client';
import { isKitRecord } from '../api/kits';
import type { Flashcard } from '@contracts';
import { useJobPolling } from '../hooks/useJobPolling';
import { useKit } from '../hooks/useKit';
import { Button, Chip, EmptyState, ErrorBanner, FullPageSpinner } from '../components/primitives';
import { ProgressTimeline } from '../components/ProgressTimeline';
import { useToast } from '../components/ToastContext';
import { CONFIDENCE_LABELS } from '../lib/labels';
import { orderCardsForPractice } from '../lib/practice';
import type { PracticeMap } from '../lib/weakSpots';
import { formatRelative } from '../lib/dates';

interface SessionEntry {
  confidence: 1 | 2 | 3;
  at: string;
}

const CONFIDENCE_BUTTONS: Array<{ level: 1 | 2 | 3; variant: 'danger' | 'secondary' | 'success' }> = [
  { level: 1, variant: 'danger' },
  { level: 2, variant: 'secondary' },
  { level: 3, variant: 'success' },
];

export default function PracticePage() {
  const { id } = useParams<{ id: string }>();
  const [params] = useSearchParams();
  const focusReq = params.get('req');
  const { kit, setKit, loading, error, refresh, mutate } = useKit(id);
  const { toast } = useToast();

  // If the kit is still generating, poll so practice unlocks automatically.
  const pending = kit?.status === 'pending';
  useJobPolling(id, !!pending, () => {
    void refresh();
  });

  const [queue, setQueue] = useState<Flashcard[] | null>(null);
  const [index, setIndex] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [session, setSession] = useState<Record<string, SessionEntry>>({});

  // Practice view: server record overlaid with this session's results.
  const practiceView = useMemo<PracticeMap>(() => {
    const merged: PracticeMap = { ...(kit?.practice ?? {}) };
    for (const [fid, entry] of Object.entries(session)) {
      merged[fid] = { confidence: entry.confidence, lastPracticedAt: entry.at };
    }
    return merged;
  }, [kit?.practice, session]);

  const buildQueue = useCallback(
    (source: Flashcard[], practice: PracticeMap) =>
      orderCardsForPractice(source, practice, focusReq),
    [focusReq],
  );

  // Build the queue once per kit/focus change (not after every confidence POST).
  useEffect(() => {
    if (kit?.status === 'ready' && queue === null) {
      setQueue(buildQueue(kit.kit?.flashcards ?? [], kit.practice ?? {}));
      setIndex(0);
      setRevealed(false);
    }
  }, [kit, queue, buildQueue]);

  const card = queue !== null && index < queue.length ? queue[index] : null;
  const cardRecord = card ? practiceView[card.id] : undefined;
  const total = queue?.length ?? 0;

  const restart = () => {
    if (!kit) return;
    setQueue(buildQueue(kit.kit?.flashcards ?? [], { ...(kit.practice ?? {}), ...practiceView }));
    setIndex(0);
    setRevealed(false);
    setSession({});
  };

  const submit = async (level: 1 | 2 | 3) => {
    if (!card || busy || !revealed || !id) return;
    setBusy(true);
    const at = new Date().toISOString();
    setSession((s) => ({ ...s, [card.id]: { confidence: level, at } }));
    try {
      const res = await mutate('POST', `/kits/${id}/flashcards/${card.id}/confidence`, { level });
      if (!isKitRecord(res)) {
        // Endpoint did not return the kit document: apply optimistically.
        setKit((cur) =>
          cur
            ? {
                ...cur,
                practice: {
                  ...(cur.practice ?? {}),
                  [card.id]: { confidence: level, lastPracticedAt: at },
                },
              }
            : cur,
        );
      }
    } catch (e) {
      toast(errMessage(e), 'error');
    } finally {
      setBusy(false);
      setRevealed(false);
      setIndex((i) => i + 1);
    }
  };

  // Keyboard: Space/Enter reveals (when not on a control), 1/2/3 rate.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON', 'A'].includes(target.tagName)) return;
      if (!card) return;
      if ((e.key === ' ' || e.key === 'Enter') && !revealed) {
        e.preventDefault();
        setRevealed(true);
        return;
      }
      if (revealed && !busy && (e.key === '1' || e.key === '2' || e.key === '3')) {
        e.preventDefault();
        void submit(Number(e.key) as 1 | 2 | 3);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [card, revealed, busy, submit]);

  /* --------------------------------------------------------------- regimes */

  if (loading) return <FullPageSpinner label="Loading practice…" />;

  if (!kit) {
    return (
      <div className="space-y-4">
        <BackLink kitId={id} />
        {error ? (
          <ErrorBanner message={error}>
            <Button size="sm" variant="secondary" onClick={() => void refresh()}>
              Try again
            </Button>
          </ErrorBanner>
        ) : (
          <ErrorBanner title="Kit not found" message="This kit does not exist or is not yours." />
        )}
      </div>
    );
  }

  if (kit.status === 'pending') {
    return (
      <div className="space-y-5">
        <BackLink kitId={id} />
        <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-5">
          <p className="text-sm text-slate-300">
            This kit is still generating. Practice unlocks automatically once it is ready — keep
            this page open or come back later.
          </p>
          <div className="mt-4">
            <ProgressTimeline job={null} />
          </div>
        </div>
      </div>
    );
  }

  if (kit.status === 'failed') {
    return (
      <div className="space-y-4">
        <BackLink kitId={id} />
        <ErrorBanner
          title="This kit failed to generate"
          message="Retry generation from the kit page, then come back to practise."
        >
          <Link
            to={id ? `/kits/${id}` : '/'}
            className="rounded-lg bg-rose-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-rose-500"
          >
            Go to the kit
          </Link>
        </ErrorBanner>
      </div>
    );
  }

  if (queue === null) return <FullPageSpinner label="Preparing your session…" />;

  if (total === 0) {
    return (
      <div className="space-y-4">
        <BackLink kitId={id} />
        <EmptyState
          icon={Layers}
          title="No flashcards to practise"
          description="This kit has no flashcards yet. Add some in the builder and come back."
        >
          <Link
            to={id ? `/kits/${id}` : '/'}
            className="rounded-lg bg-indigo-500 px-3.5 py-2 text-sm font-medium text-white hover:bg-indigo-400"
          >
            Open the builder
          </Link>
        </EmptyState>
      </div>
    );
  }

  const sessionEntries = Object.values(session);
  const levelCounts: Record<1 | 2 | 3, number> = { 1: 0, 2: 0, 3: 0 };
  for (const entry of sessionEntries) levelCounts[entry.confidence] += 1;
  const weakCards = queue.filter((c) => practiceView[c.id]?.confidence === 1);
  const avgSession =
    sessionEntries.length > 0
      ? sessionEntries.reduce((s, e) => s + e.confidence, 0) / sessionEntries.length
      : null;

  /* --------------------------------------------------------- end screen */

  if (!card) {
    return (
      <div className="mx-auto max-w-2xl space-y-5">
        <BackLink kitId={id} />
        <section className="rounded-2xl border border-slate-800 bg-slate-900/60 p-6 text-center">
          <span className="mx-auto grid h-12 w-12 place-items-center rounded-full bg-emerald-500/15 text-emerald-300">
            <Check className="h-6 w-6" aria-hidden />
          </span>
          <h1 className="mt-3 text-lg font-semibold">Session complete</h1>
          <p className="mt-1 text-sm text-slate-400">
            You rated {sessionEntries.length} of {total} card{total === 1 ? '' : 's'}
            {avgSession !== null ? ` · average confidence ${avgSession.toFixed(1)}/3` : ''}.
          </p>
          <div className="mt-4 flex flex-wrap justify-center gap-2">
            <Chip className="border-rose-500/50 bg-rose-500/15 text-rose-300">
              {levelCounts[1]} not confident
            </Chip>
            <Chip className="border-amber-500/50 bg-amber-500/15 text-amber-300">
              {levelCounts[2]} shaky
            </Chip>
            <Chip className="border-emerald-500/50 bg-emerald-500/15 text-emerald-300">
              {levelCounts[3]} solid
            </Chip>
          </div>
          <div className="mt-6 flex flex-wrap justify-center gap-2">
            <Button icon={GraduationCap} onClick={restart}>
              Practice again
            </Button>
            {id ? (
              <Link
                to={`/kits/${id}`}
                className="rounded-lg border border-slate-700 bg-slate-900 px-3.5 py-2 text-sm font-medium text-slate-200 hover:border-slate-500 hover:text-white"
              >
                Back to the kit
              </Link>
            ) : null}
          </div>
        </section>

        <section className="rounded-2xl border border-slate-800 bg-slate-900/60 p-6">
          <h2 className="text-sm font-semibold text-slate-200">Still shaky after this session</h2>
          {weakCards.length > 0 ? (
            <ul className="mt-3 space-y-2">
              {weakCards.map((c) => (
                <li key={c.id} className="flex items-start gap-2 text-sm text-slate-300">
                  <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-rose-400" aria-hidden />
                  <span className="min-w-0 break-words">{c.front}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-2 text-sm text-slate-400">
              Nothing rated “not confident” — nice work. Your weakest requirements are still ranked
              in the Weak spots tab.
            </p>
          )}
        </section>
      </div>
    );
  }

  /* --------------------------------------------------------- active card */

  const progressPercent = total > 0 ? Math.round((index / total) * 100) : 0;

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <BackLink kitId={id} />

      <div>
        <div className="mb-1.5 flex items-center justify-between text-xs text-slate-400">
          <span aria-live="polite">
            Card {index + 1} of {total}
          </span>
          <span>
            {sessionEntries.length} rated this session
          </span>
        </div>
        <div
          role="progressbar"
          aria-label="Practice progress"
          aria-valuemin={0}
          aria-valuemax={total}
          aria-valuenow={index}
          className="h-2 w-full overflow-hidden rounded-full bg-slate-800"
        >
          <div
            className="h-full rounded-full bg-indigo-500 transition-all duration-300"
            style={{ width: `${progressPercent}%` }}
          />
        </div>
      </div>

      <article
        aria-label={`Flashcard ${card.id}`}
        className="rounded-2xl border border-slate-800 bg-slate-900 p-6 shadow-lg shadow-black/20 sm:p-8"
      >
        <div className="flex items-center justify-between text-xs text-slate-500">
          <span>Front</span>
          {cardRecord ? (
            <Chip title={`Last practiced ${formatRelative(cardRecord.lastPracticedAt)}`}>
              {CONFIDENCE_LABELS[cardRecord.confidence]} · {formatRelative(cardRecord.lastPracticedAt)}
            </Chip>
          ) : null}
        </div>
        <p className="mt-2 whitespace-pre-wrap text-lg font-medium text-slate-100">{card.front}</p>

        {revealed ? (
          <div className="mt-6 border-t border-slate-800 pt-6">
            <p className="text-xs uppercase tracking-wide text-slate-500">Back</p>
            <p className="mt-2 whitespace-pre-wrap text-slate-200">{card.back}</p>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setRevealed(true)}
            className="mt-6 w-full rounded-xl border border-dashed border-slate-700 py-6 text-sm text-slate-400 transition-colors hover:border-indigo-400 hover:text-indigo-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400"
          >
            Show answer <span className="ml-1 rounded border border-slate-700 px-1.5 py-0.5 text-[10px]">Space</span>
          </button>
        )}
      </article>

      {revealed ? (
        <div className="space-y-2">
          <div className="grid grid-cols-3 gap-2">
            {CONFIDENCE_BUTTONS.map(({ level, variant }) => (
              <Button
                key={level}
                variant={variant}
                disabled={busy}
                onClick={() => void submit(level)}
                aria-label={`Rate confidence ${level}: ${CONFIDENCE_LABELS[level]}`}
              >
                {level} · {CONFIDENCE_LABELS[level]}
              </Button>
            ))}
          </div>
          <p className="text-center text-xs text-slate-500">
            How confident did you feel? Keys 1, 2, 3 also work.
          </p>
        </div>
      ) : (
        <p className="text-center text-xs text-slate-500">
          Reveal the answer, then rate yourself to move on.
        </p>
      )}
    </div>
  );
}

function BackLink({ kitId }: { kitId: string | undefined }) {
  return (
    <div>
      <Link
        to={kitId ? `/kits/${kitId}` : '/'}
        className="inline-flex items-center gap-1.5 rounded-lg text-sm text-slate-400 transition-colors hover:text-slate-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400"
      >
        <ArrowLeft className="h-4 w-4" aria-hidden />
        Back to the kit
      </Link>
    </div>
  );
}
