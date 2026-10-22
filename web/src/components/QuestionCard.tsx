// One question in the builder: inline-editable prompt and answer outline,
// difficulty and category selects (moving category re-files the question),
// requirement chips, pin toggle, reorder buttons, delete-with-confirm, and an
// origin badge (generated / manual / edited / pinned).

import { ChevronDown, ChevronUp, Pin, PinOff, Trash2 } from 'lucide-react';
import type { Question, Requirement } from '@contracts';
import { errMessage } from '../api/client';
import { useToast } from './ToastContext';
import { EditableText } from './EditableText';
import { Chip, ConfirmButton, Select, focusRing } from './primitives';
import {
  CATEGORY_LABELS,
  DIFFICULTY_LABELS,
  QUESTION_CATEGORIES,
  originBadge,
} from '../lib/labels';
import type { QuestionPatch } from '../lib/mutations';

export interface QuestionCardProps {
  question: Question;
  requirements: Requirement[];
  canMoveUp: boolean;
  canMoveDown: boolean;
  highlighted?: boolean;
  onPatch: (patch: QuestionPatch) => Promise<void>;
  onDelete: () => void;
  onTogglePin: () => void;
  onMove: (direction: -1 | 1) => void;
}

export function QuestionCard({
  question,
  requirements,
  canMoveUp,
  canMoveDown,
  highlighted = false,
  onPatch,
  onDelete,
  onTogglePin,
  onMove,
}: QuestionCardProps) {
  const { toast } = useToast();
  const badge = originBadge(question);
  const reqById = new Map(requirements.map((r) => [r.id, r]));

  const guardedPatch = (patch: QuestionPatch) => {
    onPatch(patch).catch((e: unknown) => toast(errMessage(e), 'error'));
  };

  return (
    <article
      id={`question-${question.id}`}
      aria-label={`Question ${question.id}`}
      className={`scroll-mt-28 rounded-xl border bg-slate-900/60 p-4 transition-shadow ${
        highlighted ? 'border-indigo-400/70 ring-2 ring-indigo-400/50' : 'border-slate-800'
      }`}
    >
      <div className="mb-2 flex flex-wrap items-center gap-1.5">
        <Chip className={badge.className}>{badge.label}</Chip>
        <Chip title={question.id}>{question.id}</Chip>
        {question.requirement_ids.map((rid) => {
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
        <span className="ml-auto flex items-center gap-1">
          <button
            type="button"
            onClick={() => onMove(-1)}
            disabled={!canMoveUp}
            aria-label={`Move question ${question.id} up`}
            title="Move up"
            className={`rounded-md p-1.5 text-slate-400 transition-colors hover:bg-slate-800 hover:text-white disabled:cursor-not-allowed disabled:opacity-30 ${focusRing}`}
          >
            <ChevronUp className="h-4 w-4" aria-hidden />
          </button>
          <button
            type="button"
            onClick={() => onMove(1)}
            disabled={!canMoveDown}
            aria-label={`Move question ${question.id} down`}
            title="Move down"
            className={`rounded-md p-1.5 text-slate-400 transition-colors hover:bg-slate-800 hover:text-white disabled:cursor-not-allowed disabled:opacity-30 ${focusRing}`}
          >
            <ChevronDown className="h-4 w-4" aria-hidden />
          </button>
          <button
            type="button"
            onClick={onTogglePin}
            aria-pressed={question.pinned}
            aria-label={
              question.pinned
                ? `Unpin question ${question.id}`
                : `Pin question ${question.id} so regeneration keeps it`
            }
            title={question.pinned ? 'Unpin' : 'Pin — kept through regeneration'}
            className={`rounded-md p-1.5 transition-colors hover:bg-slate-800 ${focusRing} ${
              question.pinned ? 'text-indigo-300' : 'text-slate-400 hover:text-white'
            }`}
          >
            {question.pinned ? (
              <Pin className="h-4 w-4 fill-current" aria-hidden />
            ) : (
              <PinOff className="h-4 w-4" aria-hidden />
            )}
          </button>
          <ConfirmButton
            label="Delete"
            confirmLabel="Delete question?"
            note="This also removes it from the schedule."
            icon={Trash2}
            variant="danger-ghost"
            onConfirm={onDelete}
            aria-label={`Delete question ${question.id}`}
          />
        </span>
      </div>

      <div className="space-y-1.5">
        <EditableText
          value={question.prompt}
          label={`question ${question.id} prompt`}
          onSave={(v) => onPatch({ prompt: v })}
          rows={2}
          displayClassName="text-[15px] font-medium text-slate-100"
        />
        <div>
          <p className="px-2 text-[11px] font-medium uppercase tracking-wide text-slate-500">
            Answer outline
          </p>
          <EditableText
            value={question.answer_outline}
            label={`question ${question.id} answer outline`}
            onSave={(v) => onPatch({ answer_outline: v })}
            rows={3}
            placeholder="Click to add an answer outline"
            displayClassName="text-sm text-slate-300"
          />
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-1.5 text-xs text-slate-400">
          <span className="sr-only sm:not-sr-only">Difficulty</span>
          <Select
            value={question.difficulty}
            onChange={(e) => guardedPatch({ difficulty: Number(e.target.value) as 1 | 2 | 3 })}
            aria-label={`Difficulty for question ${question.id}`}
            className="w-auto py-1 text-xs"
          >
            {([1, 2, 3] as const).map((d) => (
              <option key={d} value={d}>
                {d} · {DIFFICULTY_LABELS[d]}
              </option>
            ))}
          </Select>
        </label>
        <label className="flex items-center gap-1.5 text-xs text-slate-400">
          <span className="sr-only sm:not-sr-only">Category</span>
          <Select
            value={question.category}
            onChange={(e) => guardedPatch({ category: e.target.value as Question['category'] })}
            aria-label={`Category for question ${question.id}`}
            className="w-auto py-1 text-xs"
          >
            {QUESTION_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {CATEGORY_LABELS[c]}
              </option>
            ))}
          </Select>
        </label>
      </div>
    </article>
  );
}
