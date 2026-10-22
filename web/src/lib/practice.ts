// Practice session ordering: cards with no practice record first, then
// ascending confidence, then least-recently-practiced. A simple
// confidence-weighted sort — cheap to reason about and easy to defend.

import type { Flashcard } from '@contracts';
import type { PracticeMap } from './weakSpots';

function compareCards(a: Flashcard, b: Flashcard, practice: PracticeMap): number {
  const pa = practice[a.id];
  const pb = practice[b.id];
  if (!pa && !pb) return a.id.localeCompare(b.id, undefined, { numeric: true });
  if (!pa) return -1;
  if (!pb) return 1;
  if (pa.confidence !== pb.confidence) return pa.confidence - pb.confidence;
  const ta = pa.lastPracticedAt ?? '';
  const tb = pb.lastPracticedAt ?? '';
  if (ta !== tb) return ta < tb ? -1 : 1;
  return a.id.localeCompare(b.id, undefined, { numeric: true });
}

export function orderCardsForPractice(
  cards: Flashcard[],
  practice: PracticeMap,
  focusRequirementId?: string | null,
): Flashcard[] {
  if (!focusRequirementId) return [...cards].sort((a, b) => compareCards(a, b, practice));
  const focused = cards.filter((c) => (c.requirement_ids ?? []).includes(focusRequirementId));
  const focusedIds = new Set(focused.map((c) => c.id));
  const rest = cards.filter((c) => !focusedIds.has(c.id));
  return [...focused].sort((a, b) => compareCards(a, b, practice))
    .concat([...rest].sort((a, b) => compareCards(a, b, practice)));
}
