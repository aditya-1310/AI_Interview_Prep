// Weak-spots ranking, computed entirely client-side from the kit document and
// the practice map. No backend involvement.
//
// Ranking rules: requirements that coverage marked uncovered come first, then
// ascending average flashcard confidence (a card that was never practiced
// counts as 0), then must-haves before nice-to-haves, then by id.

import type { Kit } from '@contracts';

export type PracticeMap = Record<string, { confidence: 1 | 2 | 3; lastPracticedAt: string }>;

export interface WeakSpot {
  requirementId: string;
  requirementText: string;
  priority: 'must' | 'nice';
  kind: string;
  uncovered: boolean;
  questionCount: number;
  cardCount: number;
  practicedCount: number;
  /** Mean confidence with unpracticed cards as 0; null when no cards exist. */
  avgConfidence: number | null;
}

export function rankWeakSpots(kit: Kit | undefined, practice: PracticeMap | undefined): WeakSpot[] {
  const requirements = kit?.role?.requirements ?? [];
  const questions = kit?.questions ?? [];
  const flashcards = kit?.flashcards ?? [];
  const uncovered = new Set(kit?.coverage?.uncovered_requirement_ids ?? []);

  const spots: WeakSpot[] = requirements.map((r) => {
    const cards = flashcards.filter((c) => (c.requirement_ids ?? []).includes(r.id));
    const practiced = cards.filter((c) => practice?.[c.id] !== undefined);
    const sum = cards.reduce((acc, c) => acc + (practice?.[c.id]?.confidence ?? 0), 0);
    return {
      requirementId: r.id,
      requirementText: r.text,
      priority: r.priority,
      kind: r.kind,
      uncovered: uncovered.has(r.id),
      questionCount: questions.filter((q) => (q.requirement_ids ?? []).includes(r.id)).length,
      cardCount: cards.length,
      practicedCount: practiced.length,
      avgConfidence: cards.length > 0 ? sum / cards.length : null,
    };
  });

  spots.sort((a, b) => {
    if (a.uncovered !== b.uncovered) return a.uncovered ? -1 : 1;
    const ac = a.avgConfidence ?? 0;
    const bc = b.avgConfidence ?? 0;
    if (ac !== bc) return ac - bc;
    if (a.priority !== b.priority) return a.priority === 'must' ? -1 : 1;
    return a.requirementId.localeCompare(b.requirementId, undefined, { numeric: true });
  });

  return spots;
}

/** Overall practice coverage stats for the summary card. */
export function practiceTotals(
  kit: Kit | undefined,
  practice: PracticeMap | undefined,
): { totalCards: number; practicedCards: number; avgConfidence: number | null } {
  const flashcards = kit?.flashcards ?? [];
  const practiced = flashcards.filter((c) => practice?.[c.id] !== undefined);
  const sum = practiced.reduce((acc, c) => acc + (practice?.[c.id]?.confidence ?? 0), 0);
  return {
    totalCards: flashcards.length,
    practicedCards: practiced.length,
    avgConfidence: practiced.length > 0 ? sum / practiced.length : null,
  };
}
