// The mutation surface the builder tabs use. The KitBuilderPage constructs one
// implementation on top of useKit().mutate; tabs stay dumb to transport details.

import type { Flashcard, Question, QuestionCategory } from '@contracts';

/**
 * Sections the regenerate endpoint accepts. Mirrors `Section` in
 * server/src/core/ports.ts — the @contracts barrel (types + schemas only)
 * does not re-export it, and we may not touch the server.
 */
export type Section = 'brief' | 'technical' | 'behavioural' | 'system-design' | 'company-fit' | 'schedule';

export type QuestionPatch = Partial<
  Pick<Question, 'prompt' | 'answer_outline' | 'difficulty' | 'category' | 'requirement_ids'>
>;

export type FlashcardPatch = Partial<Pick<Flashcard, 'front' | 'back' | 'requirement_ids'>>;

export interface NewQuestionFields {
  category: QuestionCategory;
  prompt: string;
  answer_outline: string;
  difficulty: 1 | 2 | 3;
  requirement_ids: string[];
}

export interface NewFlashcardFields {
  front: string;
  back: string;
  requirement_ids: string[];
}

export interface ScheduleDayPatch {
  focus?: string;
  minutes?: number;
}

export interface KitMutations {
  /** Rejects on failure so inline editors can show their own error state. */
  patchBrief(patch: { summary?: string; what_they_do?: string }): Promise<void>;
  patchQuestion(qid: string, patch: QuestionPatch): Promise<void>;
  patchFlashcard(fid: string, patch: FlashcardPatch): Promise<void>;
  patchScheduleDay(day: number, patch: ScheduleDayPatch): Promise<void>;
  addQuestion(fields: NewQuestionFields): Promise<void>;
  addFlashcard(fields: NewFlashcardFields): Promise<void>;

  /** Fire-and-forget actions; failures surface as toasts. */
  deleteQuestion(qid: string): void;
  deleteFlashcard(fid: string): void;
  reorderQuestions(orderedIds: string[]): void;
  toggleQuestionPin(qid: string): void;
  toggleFlashcardPin(fid: string): void;
  regenerate(section: Section, days?: number): void;
  refresh(): void;
}
