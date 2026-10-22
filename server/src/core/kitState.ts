import { computeCoverage, stripDanglingRefs } from './coverage';
import { nextId } from './ids';
import { MINUTES_BY_DIFFICULTY, recomputeSchedule } from './schedule';
import type {
  Flashcard,
  Kit,
  KitDocument,
  NewManualFlashcardFields,
  NewManualQuestionFields,
  Question,
  QuestionCategory,
} from './types';

/**
 * Builder state rules:
 *  - origin 'manual'  -> written by the user, always survives regeneration
 *  - item_state 'edited' -> touched inline by the user, survives regeneration
 *  - pinned -> explicitly protected, survives regeneration
 *  - pristine generated items are the only ones a regeneration replaces
 */

export function mergeRegeneratedQuestions(
  kit: Kit,
  category: QuestionCategory,
  incoming: Question[],
): Question[] {
  const keep = kit.questions.filter(
    (q) =>
      q.category === category &&
      (q.origin === 'manual' || q.item_state === 'edited' || q.pinned),
  );
  const others = kit.questions.filter((q) => q.category !== category);
  const usedIds = kit.questions.map((q) => q.id);
  const fresh = incoming.map((q) => {
    const id = nextId('q', usedIds);
    usedIds.push(id);
    return {
      ...q,
      id,
      origin: 'generated' as const,
      item_state: 'pristine' as const,
      pinned: false,
    };
  });
  return [...others, ...keep, ...fresh];
}

export function applyQuestionEdit(
  kit: Kit,
  questionId: string,
  patch: Partial<Pick<Question, 'prompt' | 'answer_outline' | 'difficulty' | 'category' | 'requirement_ids'>>,
): Kit {
  const q = kit.questions.find((x) => x.id === questionId);
  if (!q) return kit;
  Object.assign(q, patch, { item_state: 'edited' as const });
  return kit;
}

export function addManualQuestion(kit: Kit, fields: NewManualQuestionFields): Question {
  const question: Question = {
    id: nextId('q', kit.questions.map((q) => q.id)),
    requirement_ids: fields.requirement_ids,
    category: fields.category,
    prompt: fields.prompt,
    answer_outline: fields.answer_outline,
    difficulty: fields.difficulty,
    origin: 'manual',
    item_state: 'pristine',
    pinned: false,
  };
  kit.questions.push(question);
  return question;
}

export function deleteQuestion(kit: Kit, questionId: string): Kit {
  kit.questions = kit.questions.filter((q) => q.id !== questionId);
  for (const day of kit.schedule.days) {
    day.question_ids = day.question_ids.filter((id) => id !== questionId);
  }
  // A day left with nothing to do gets a rebuilt schedule rather than an
  // invalid empty one.
  if (kit.schedule.days.some((d) => d.question_ids.length === 0 && kit.questions.length > 0)) {
    recomputeSchedule(kit);
  }
  recomputeCoverageInPlace(kit);
  return kit;
}

export function reorderQuestions(kit: Kit, orderedIds: string[]): Kit {
  const byId = new Map(kit.questions.map((q) => [q.id, q] as const));
  const reordered: Question[] = [];
  for (const id of orderedIds) {
    const q = byId.get(id);
    if (q) {
      reordered.push(q);
      byId.delete(id);
    }
  }
  kit.questions = [...reordered, ...byId.values()];
  return kit;
}

export function addManualFlashcard(kit: Kit, fields: NewManualFlashcardFields): Flashcard {
  const card: Flashcard = {
    id: nextId('f', kit.flashcards.map((f) => f.id)),
    front: fields.front,
    back: fields.back,
    requirement_ids: fields.requirement_ids,
    origin: 'manual',
    item_state: 'pristine',
    pinned: false,
  };
  kit.flashcards.push(card);
  return card;
}

export function applyFlashcardEdit(
  kit: Kit,
  flashcardId: string,
  patch: Partial<Pick<Flashcard, 'front' | 'back' | 'requirement_ids'>>,
): Kit {
  const f = kit.flashcards.find((x) => x.id === flashcardId);
  if (!f) return kit;
  Object.assign(f, patch, { item_state: 'edited' as const });
  return kit;
}

export function deleteFlashcard(kit: Kit, flashcardId: string): Kit {
  kit.flashcards = kit.flashcards.filter((f) => f.id !== flashcardId);
  return kit;
}

export function togglePin(kit: Kit, kind: 'question' | 'flashcard', id: string): Kit {
  const item =
    kind === 'question'
      ? kit.questions.find((q) => q.id === id)
      : kit.flashcards.find((f) => f.id === id);
  if (item) item.pinned = !item.pinned;
  return kit;
}

export function deleteRequirement(kit: Kit, requirementId: string): Kit {
  kit.role.requirements = kit.role.requirements.filter((r) => r.id !== requirementId);
  for (const q of kit.questions) {
    q.requirement_ids = q.requirement_ids.filter((id) => id !== requirementId);
  }
  for (const f of kit.flashcards) {
    f.requirement_ids = f.requirement_ids.filter((id) => id !== requirementId);
  }
  recomputeCoverageInPlace(kit);
  return kit;
}

export function recomputeCoverageInPlace(kit: KitDocument): KitDocument {
  stripDanglingRefs(kit);
  kit.coverage = computeCoverage(kit, kit.coverage.passes);
  return kit;
}

/**
 * After a category regeneration swapped pristine questions for fresh ones,
 * repair the schedule in place: drop ids that no longer exist, slot the new
 * questions into the day that best matches their category, and only fall back
 * to a full rebuild if some day was left empty. Manual schedule edits
 * (focus text, minutes) survive unless the rebuild fires.
 */
export function repairScheduleAfterRegen(kit: Kit, removedIds: string[], addedIds: string[]): Kit {
  const removed = new Set(removedIds);
  for (const day of kit.schedule.days) {
    day.question_ids = day.question_ids.filter((id) => !removed.has(id));
  }
  const categoryOf = new Map(kit.questions.map((q) => [q.id, q.category] as const));
  const difficultyOf = new Map(kit.questions.map((q) => [q.id, q.difficulty] as const));
  for (const id of addedIds) {
    const category = categoryOf.get(id);
    if (!category) continue;
    let target = kit.schedule.days[0];
    let bestScore = -Infinity;
    for (const day of kit.schedule.days) {
      const sameCategory = day.question_ids.filter((qid) => categoryOf.get(qid) === category).length;
      const score = sameCategory * 100 - day.question_ids.length;
      if (score > bestScore) {
        bestScore = score;
        target = day;
      }
    }
    if (!target) continue;
    target.question_ids.push(id);
    target.minutes += MINUTES_BY_DIFFICULTY[difficultyOf.get(id) ?? 2];
  }
  if (kit.schedule.days.some((d) => d.question_ids.length === 0 && kit.questions.length > 0)) {
    recomputeSchedule(kit);
  }
  recomputeCoverageInPlace(kit);
  return kit;
}
