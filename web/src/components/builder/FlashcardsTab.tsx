// Flashcards tab: rows with the same inline-edit pattern as questions, plus an
// add-by-hand form. Confidence from practice is shown when it exists.

import { useState } from 'react';
import { Layers, Plus } from 'lucide-react';
import type { Requirement } from '@contracts';
import type { KitRecordDoc } from '../../api/kits';
import { errMessage } from '../../api/client';
import { Button, EmptyState, ErrorBanner, Field, TextArea } from '../primitives';
import { FlashcardRow } from '../FlashcardRow';
import { RequirementSelector } from '../RequirementSelector';
import type { KitMutations, NewFlashcardFields } from '../../lib/mutations';

export function FlashcardsTab({ record, m }: { record: KitRecordDoc; m: KitMutations }) {
  const k = record.kit;
  const flashcards = k?.flashcards ?? [];
  const requirements = k?.role?.requirements ?? [];
  const practice = record.practice ?? {};
  const [adding, setAdding] = useState(false);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-400">
          Flashcards <span className="ml-1.5 text-slate-600">({flashcards.length})</span>
        </h3>
        <Button
          size="sm"
          variant="secondary"
          icon={Plus}
          aria-expanded={adding}
          onClick={() => setAdding((v) => !v)}
        >
          {adding ? 'Close form' : 'Add flashcard'}
        </Button>
      </div>

      {adding ? (
        <AddFlashcardForm
          requirements={requirements}
          onSubmit={async (fields) => {
            await m.addFlashcard(fields);
            setAdding(false);
          }}
          onCancel={() => setAdding(false)}
        />
      ) : null}

      {flashcards.length === 0 ? (
        <EmptyState
          icon={Layers}
          title="No flashcards yet"
          description="Flashcards are generated with the kit — you can also add your own above."
        />
      ) : (
        <ul className="space-y-3">
          {flashcards.map((card) => (
            <li key={card.id}>
              <FlashcardRow
                card={card}
                requirements={requirements}
                practice={practice[card.id]}
                onPatch={(patch) => m.patchFlashcard(card.id, patch)}
                onDelete={() => m.deleteFlashcard(card.id)}
                onTogglePin={() => m.toggleFlashcardPin(card.id)}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function AddFlashcardForm({
  requirements,
  onSubmit,
  onCancel,
}: {
  requirements: Requirement[];
  onSubmit: (fields: NewFlashcardFields) => Promise<void>;
  onCancel: () => void;
}) {
  const [front, setFront] = useState('');
  const [back, setBack] = useState('');
  const [reqIds, setReqIds] = useState<string[]>([]);
  const [frontError, setFrontError] = useState<string | null>(null);
  const [backError, setBackError] = useState<string | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const handleSubmit = async () => {
    if (front.trim().length === 0) {
      setFrontError('The front cannot be empty.');
      return;
    }
    if (back.trim().length === 0) {
      setBackError('The back cannot be empty.');
      return;
    }
    setSaving(true);
    setServerError(null);
    try {
      await onSubmit({ front: front.trim(), back: back.trim(), requirement_ids: reqIds });
    } catch (e) {
      setServerError(errMessage(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form
      className="space-y-3 rounded-xl border border-slate-700 bg-slate-900/80 p-4"
      onSubmit={(e) => {
        e.preventDefault();
        void handleSubmit();
      }}
    >
      <h4 className="text-sm font-semibold text-slate-200">Add a flashcard</h4>
      <Field id="fc-front" label="Front" error={frontError ?? undefined}>
        <TextArea
          id="fc-front"
          rows={2}
          value={front}
          onChange={(e) => {
            setFront(e.target.value);
            if (frontError) setFrontError(null);
          }}
          placeholder="The question or prompt on the front"
        />
      </Field>
      <Field id="fc-back" label="Back" error={backError ?? undefined}>
        <TextArea
          id="fc-back"
          rows={3}
          value={back}
          onChange={(e) => {
            setBack(e.target.value);
            if (backError) setBackError(null);
          }}
          placeholder="The answer on the back"
        />
      </Field>
      <div className="space-y-1.5">
        <p className="text-sm font-medium text-slate-300">Covers requirements</p>
        <RequirementSelector
          requirements={requirements}
          selected={reqIds}
          onChange={setReqIds}
          ariaLabel="Covered requirements for the new flashcard"
        />
      </div>
      {serverError ? <ErrorBanner message={serverError} /> : null}
      <div className="flex gap-2">
        <Button type="submit" pending={saving}>
          Add flashcard
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
