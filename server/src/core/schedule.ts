import { compareIds } from './ids';
import type { Kit, Question, Requirement, Schedule, ScheduleDay } from './types';

/**
 * Deterministic schedule allocation - arithmetic in code, never a prompt.
 *
 * Rules (defended in the README):
 *  - exactly the requested number of days, 1..60
 *  - per-question minutes by difficulty: 1 -> 20, 2 -> 30, 3 -> 45 (integers)
 *  - ordering: must-have-covering questions first, harder first within a tier,
 *    categories kept contiguous so a day has one focus
 *  - days <= questions: contiguous partition, every day non-empty, earlier
 *    days slightly larger so hard material lands early
 *  - days > questions: one material day per question, then review days cycling
 *    the ordered list at half minutes
 *  - every question is scheduled, so every must-have requirement (which by the
 *    coverage invariant has at least one question) appears in the schedule
 */

export const MINUTES_BY_DIFFICULTY: Record<1 | 2 | 3, number> = { 1: 20, 2: 30, 3: 45 };

const CATEGORY_ORDER = ['technical', 'system-design', 'behavioural', 'company-fit'] as const;

const CATEGORY_LABEL: Record<Question['category'], string> = {
  technical: 'Technical practice',
  'system-design': 'System design',
  behavioural: 'Behavioural interview',
  'company-fit': 'Company & role fit',
};

export function orderQuestions(questions: Question[], requirements: Requirement[]): Question[] {
  const mustIds = new Set(requirements.filter((r) => r.priority === 'must').map((r) => r.id));
  const coversMust = (q: Question) => q.requirement_ids.some((id) => mustIds.has(id));
  return [...questions].sort((a, b) => {
    const tier = (coversMust(a) ? 0 : 1) - (coversMust(b) ? 0 : 1);
    if (tier !== 0) return tier;
    if (a.difficulty !== b.difficulty) return b.difficulty - a.difficulty;
    const cat = CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category);
    if (cat !== 0) return cat;
    return compareIds(a.id, b.id);
  });
}

function topicFor(question: Question, requirements: Requirement[]): string {
  const byId = new Map(requirements.map((r) => [r.id, r.text] as const));
  const text = question.requirement_ids
    .map((id) => byId.get(id))
    .find((t): t is string => Boolean(t));
  if (!text) return question.prompt.slice(0, 34);
  return text.length > 34 ? `${text.slice(0, 34)}...` : text;
}

function focusFor(group: Question[], requirements: Requirement[]): string {
  const counts = new Map<Question['category'], number>();
  for (const q of group) counts.set(q.category, (counts.get(q.category) ?? 0) + 1);
  let dominant: Question['category'] = 'technical';
  let best = -1;
  for (const cat of CATEGORY_ORDER) {
    const n = counts.get(cat) ?? 0;
    if (n > best) {
      best = n;
      dominant = cat;
    }
  }
  const topics: string[] = [];
  for (const q of group) {
    const t = topicFor(q, requirements);
    if (!topics.includes(t)) topics.push(t);
    if (topics.length === 2) break;
  }
  const topicPart = topics.length ? `: ${topics.join(' · ')}` : '';
  return `${CATEGORY_LABEL[dominant]}${topicPart}`;
}

export function buildSchedule(
  questions: Question[],
  requirements: Requirement[],
  days: number,
): Schedule {
  if (!Number.isInteger(days) || days < 1 || days > 60) {
    throw new RangeError(`days must be an integer between 1 and 60, got ${days}`);
  }

  const result: ScheduleDay[] = [];

  if (questions.length === 0) {
    for (let d = 1; d <= days; d++) {
      result.push({
        day: d,
        focus: 'Read the company brief, the job description and your notes',
        question_ids: [],
        minutes: 30,
      });
    }
    return { days_available: days, days: result };
  }

  const ordered = orderQuestions(questions, requirements);

  if (days <= ordered.length) {
    const n = ordered.length;
    const base = Math.floor(n / days);
    const extra = n % days;
    let idx = 0;
    for (let d = 1; d <= days; d++) {
      const size = base + (d <= extra ? 1 : 0);
      const group = ordered.slice(idx, idx + size);
      idx += size;
      result.push({
        day: d,
        focus: focusFor(group, requirements),
        question_ids: group.map((q) => q.id),
        minutes: group.reduce((sum, q) => sum + MINUTES_BY_DIFFICULTY[q.difficulty], 0),
      });
    }
    return { days_available: days, days: result };
  }

  // More days than questions: material days first, then spaced review days.
  for (let d = 1; d <= ordered.length; d++) {
    const q = ordered[d - 1];
    result.push({
      day: d,
      focus: focusFor([q], requirements),
      question_ids: [q.id],
      minutes: MINUTES_BY_DIFFICULTY[q.difficulty],
    });
  }
  const stride = ordered.length > 2 ? Math.ceil(ordered.length / 2) : 1;
  const reviews = days - ordered.length;
  for (let j = 0; j < reviews; j++) {
    const q = ordered[(j * stride) % ordered.length];
    result.push({
      day: ordered.length + j + 1,
      focus: `Review: ${topicFor(q, requirements)}`,
      question_ids: [q.id],
      minutes: Math.ceil(MINUTES_BY_DIFFICULTY[q.difficulty] / 2),
    });
  }
  return { days_available: days, days: result };
}

/** Rebuild the schedule on the current question set (used after edits). */
export function recomputeSchedule(kit: Kit): Kit {
  kit.schedule = buildSchedule(kit.questions, kit.role.requirements, kit.schedule.days_available);
  return kit;
}
