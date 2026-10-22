// Questions tab: four fixed categories, each with its own add form and
// regenerate action (confirm notes that manual/edited/pinned questions are
// kept). Move up/down reorders within the category and posts the full order.

import { useState } from 'react';
import { ListChecks, Plus } from 'lucide-react';
import type { Question, QuestionCategory, Requirement } from '@contracts';
import type { KitRecordDoc } from '../../api/kits';
import { errMessage } from '../../api/client';
import { Button, ConfirmButton, EmptyState, ErrorBanner, Field, Select, TextArea } from '../primitives';
import { QuestionCard } from '../QuestionCard';
import { RequirementSelector } from '../RequirementSelector';
import { CATEGORY_LABELS, DIFFICULTY_LABELS, QUESTION_CATEGORIES } from '../../lib/labels';
import type { KitMutations, NewQuestionFields } from '../../lib/mutations';

export function QuestionsTab({
  record,
  m,
  regenBusy,
  highlightedId,
}: {
  record: KitRecordDoc;
  m: KitMutations;
  regenBusy: boolean;
  highlightedId: string | null;
}) {
  const k = record.kit;
  const questions = k?.questions ?? [];
  const requirements = k?.role?.requirements ?? [];
  const [addingIn, setAddingIn] = useState<QuestionCategory | null>(null);

  const move = (question: Question, direction: -1 | 1) => {
    const ordered = [...questions];
    const i = ordered.findIndex((q) => q.id === question.id);
    if (i < 0) return;
    // Swap with the nearest neighbour in the same category.
    let j = i + direction;
    while (j >= 0 && j < ordered.length && ordered[j].category !== question.category) {
      j += direction;
    }
    if (j < 0 || j >= ordered.length) return;
    [ordered[i], ordered[j]] = [ordered[j], ordered[i]];
    m.reorderQuestions(ordered.map((q) => q.id));
  };

  return (
    <div className="space-y-8">
      {QUESTION_CATEGORIES.map((category) => {
        const items = questions.filter((q) => q.category === category);
        return (
          <section key={category} aria-labelledby={`category-${category}`}>
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <h3
                id={`category-${category}`}
                className="text-sm font-semibold uppercase tracking-wide text-slate-400"
              >
                {CATEGORY_LABELS[category]}
                <span className="ml-1.5 text-slate-600">({items.length})</span>
              </h3>
              <div className="ml-auto flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="secondary"
                  icon={Plus}
                  aria-expanded={addingIn === category}
                  onClick={() => setAddingIn(addingIn === category ? null : category)}
                >
                  {addingIn === category ? 'Close form' : 'Add question'}
                </Button>
                <ConfirmButton
                  label="Regenerate"
                  confirmLabel="Regenerate — keep my edits"
                  note={`Regenerates the ${CATEGORY_LABELS[category].toLowerCase()} category. Questions you added, edited, or pinned are kept.`}
                  onConfirm={() => m.regenerate(category)}
                  disabled={regenBusy}
                />
              </div>
            </div>

            {addingIn === category ? (
              <AddQuestionForm
                category={category}
                requirements={requirements}
                onSubmit={async (fields) => {
                  await m.addQuestion(fields);
                  setAddingIn(null);
                }}
                onCancel={() => setAddingIn(null)}
              />
            ) : null}

            {items.length === 0 ? (
              <EmptyState
                icon={ListChecks}
                title={`No ${CATEGORY_LABELS[category].toLowerCase()} questions yet`}
                description={
                  items.length === 0 && questions.length === 0
                    ? 'Generate a kit first, or add a question by hand above.'
                    : 'Add one by hand, or regenerate this category.'
                }
              />
            ) : (
              <ul className="space-y-3">
                {items.map((q, i) => (
                  <li key={q.id}>
                    <QuestionCard
                      question={q}
                      requirements={requirements}
                      canMoveUp={i > 0}
                      canMoveDown={i < items.length - 1}
                      highlighted={highlightedId === q.id}
                      onPatch={(patch) => m.patchQuestion(q.id, patch)}
                      onDelete={() => m.deleteQuestion(q.id)}
                      onTogglePin={() => m.toggleQuestionPin(q.id)}
                      onMove={(direction) => move(q, direction)}
                    />
                  </li>
                ))}
              </ul>
            )}
          </section>
        );
      })}
    </div>
  );
}

function AddQuestionForm({
  category,
  requirements,
  onSubmit,
  onCancel,
}: {
  category: QuestionCategory;
  requirements: Requirement[];
  onSubmit: (fields: NewQuestionFields) => Promise<void>;
  onCancel: () => void;
}) {
  const [prompt, setPrompt] = useState('');
  const [outline, setOutline] = useState('');
  const [difficulty, setDifficulty] = useState<1 | 2 | 3>(2);
  const [reqIds, setReqIds] = useState<string[]>([]);
  const [promptError, setPromptError] = useState<string | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const handleSubmit = async () => {
    if (prompt.trim().length === 0) {
      setPromptError('The prompt cannot be empty.');
      return;
    }
    setSaving(true);
    setServerError(null);
    try {
      await onSubmit({
        category,
        prompt: prompt.trim(),
        answer_outline: outline,
        difficulty,
        requirement_ids: reqIds,
      });
    } catch (e) {
      setServerError(errMessage(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form
      className="mb-4 space-y-3 rounded-xl border border-slate-700 bg-slate-900/80 p-4"
      onSubmit={(e) => {
        e.preventDefault();
        void handleSubmit();
      }}
    >
      <h4 className="text-sm font-semibold text-slate-200">
        Add a {CATEGORY_LABELS[category].toLowerCase()} question
      </h4>
      <Field id={`q-prompt-${category}`} label="Prompt" error={promptError ?? undefined}>
        <TextArea
          id={`q-prompt-${category}`}
          rows={2}
          value={prompt}
          onChange={(e) => {
            setPrompt(e.target.value);
            if (promptError) setPromptError(null);
          }}
          placeholder="e.g. Walk me through how you would design…"
        />
      </Field>
      <Field id={`q-outline-${category}`} label="Answer outline (optional)">
        <TextArea
          id={`q-outline-${category}`}
          rows={3}
          value={outline}
          onChange={(e) => setOutline(e.target.value)}
          placeholder="Bullet points you want to remember"
        />
      </Field>
      <div className="grid gap-3 sm:grid-cols-[auto_1fr] sm:items-start">
        <Field id={`q-difficulty-${category}`} label="Difficulty">
          <Select
            id={`q-difficulty-${category}`}
            value={difficulty}
            onChange={(e) => setDifficulty(Number(e.target.value) as 1 | 2 | 3)}
            className="w-36"
          >
            {([1, 2, 3] as const).map((d) => (
              <option key={d} value={d}>
                {d} · {DIFFICULTY_LABELS[d]}
              </option>
            ))}
          </Select>
        </Field>
        <div className="space-y-1.5">
          <p className="text-sm font-medium text-slate-300">Covers requirements</p>
          <RequirementSelector requirements={requirements} selected={reqIds} onChange={setReqIds} />
        </div>
      </div>
      {serverError ? <ErrorBanner message={serverError} /> : null}
      <div className="flex gap-2">
        <Button type="submit" pending={saving}>
          Add question
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
