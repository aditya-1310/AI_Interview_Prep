// One flashcard in the builder: inline-editable front/back, requirement
// chips, pin toggle, delete-with-confirm, and the latest practice result.

import { Pin, PinOff, Trash2 } from 'lucide-react';
import type { Flashcard, Requirement } from '@contracts';
import { EditableText } from './EditableText';
import { Chip, ConfirmButton, focusRing } from './primitives';
import { CONFIDENCE_LABELS, originBadge } from '../lib/labels';
import { formatRelative } from '../lib/dates';

const CONFIDENCE_CHIP: Record<1 | 2 | 3, string> = {
  1: 'border-rose-500/50 bg-rose-500/15 text-rose-300',
  2: 'border-amber-500/50 bg-amber-500/15 text-amber-300',
  3: 'border-emerald-500/50 bg-emerald-500/15 text-emerald-300',
};

export interface FlashcardRowProps {
  card: Flashcard;
  requirements: Requirement[];
  practice?: { confidence: 1 | 2 | 3; lastPracticedAt: string };
  onPatch: (patch: Partial<Pick<Flashcard, 'front' | 'back' | 'requirement_ids'>>) => Promise<void>;
  onDelete: () => void;
  onTogglePin: () => void;
}

export function FlashcardRow({
  card,
  requirements,
  practice,
  onPatch,
  onDelete,
  onTogglePin,
}: FlashcardRowProps) {
  const badge = originBadge(card);
  const reqById = new Map(requirements.map((r) => [r.id, r]));

  return (
    <article
      id={`flashcard-${card.id}`}
      aria-label={`Flashcard ${card.id}`}
      className="scroll-mt-28 rounded-xl border border-slate-800 bg-slate-900/60 p-4"
    >
      <div className="mb-2 flex flex-wrap items-center gap-1.5">
        <Chip className={badge.className}>{badge.label}</Chip>
        <Chip title={card.id}>{card.id}</Chip>
        {card.requirement_ids.map((rid) => {
          const req = reqById.get(rid);
          return (
            <Chip
              key={rid}
              title={req ? `${rid}: ${req.text} (${req.priority})` : rid}
              className={
                req?.priority === 'must'
                  ? 'border-indigo-500/50 bg-indigo-500/15 text-indigo-300'
                  : undefined
              }
            >
              {rid}
            </Chip>
          );
        })}
        {practice ? (
          <Chip
            className={CONFIDENCE_CHIP[practice.confidence]}
            title={`Last practiced ${formatRelative(practice.lastPracticedAt)}`}
          >
            {CONFIDENCE_LABELS[practice.confidence]}
          </Chip>
        ) : (
          <Chip className="border-slate-700 text-slate-500">Not practiced</Chip>
        )}
        <span className="ml-auto flex items-center gap-1">
          <button
            type="button"
            onClick={onTogglePin}
            aria-pressed={card.pinned}
            aria-label={card.pinned ? `Unpin flashcard ${card.id}` : `Pin flashcard ${card.id}`}
            title={card.pinned ? 'Unpin' : 'Pin — kept through regeneration'}
            className={`rounded-md p-1.5 transition-colors hover:bg-slate-800 ${focusRing} ${
              card.pinned ? 'text-indigo-300' : 'text-slate-400 hover:text-white'
            }`}
          >
            {card.pinned ? (
              <Pin className="h-4 w-4 fill-current" aria-hidden />
            ) : (
              <PinOff className="h-4 w-4" aria-hidden />
            )}
          </button>
          <ConfirmButton
            label="Delete"
            confirmLabel="Delete card?"
            icon={Trash2}
            variant="danger-ghost"
            onConfirm={onDelete}
            aria-label={`Delete flashcard ${card.id}`}
          />
        </span>
      </div>

      <div className="space-y-1.5">
        <div>
          <p className="px-2 text-[11px] font-medium uppercase tracking-wide text-slate-500">
            Front
          </p>
          <EditableText
            value={card.front}
            label={`flashcard ${card.id} front`}
            onSave={(v) => onPatch({ front: v })}
            rows={2}
            displayClassName="text-sm font-medium text-slate-100"
          />
        </div>
        <div>
          <p className="px-2 text-[11px] font-medium uppercase tracking-wide text-slate-500">
            Back
          </p>
          <EditableText
            value={card.back}
            label={`flashcard ${card.id} back`}
            onSave={(v) => onPatch({ back: v })}
            rows={3}
            displayClassName="text-sm text-slate-300"
          />
        </div>
      </div>
    </article>
  );
}
