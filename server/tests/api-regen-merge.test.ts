// Pins the concurrent-edit semantics of mergeRegeneratedSection: work the user
// did WHILE a regeneration was running must survive the regeneration write.
import { describe, expect, it } from 'vitest';
import { mergeRegeneratedSection } from '../src/jobs/runner';
import type { Kit, Question } from '../src/core/types';
import { buildSchedule } from '../src/core/schedule';

function q(
  id: string,
  category: Question['category'],
  requirement_ids: string[],
  overrides: Partial<Question> = {},
): Question {
  return {
    id,
    requirement_ids,
    category,
    prompt: `Prompt ${id}`,
    answer_outline: 'outline',
    difficulty: 2,
    origin: 'generated',
    item_state: 'pristine',
    pinned: false,
    ...overrides,
  };
}

function kitWith(questions: Question[], brief = { summary: 'old', what_they_do: 'old' }): Kit {
  const requirements = [
    { id: 'r1', text: 'React', kind: 'technical' as const, priority: 'must' as const },
    { id: 'r2', text: 'Mentoring', kind: 'behavioural' as const, priority: 'must' as const },
  ];
  return {
    source: { company: 'Acme', company_url: 'https://a.test', role: 'Eng', location: '', jd_chars: 10, researched_at: '2026-10-22T00:00:00Z', pages_used: [] },
    company_brief: { summary: brief.summary, what_they_do: brief.what_they_do, sources: [] },
    role: { title: 'Eng', seniority: 'mid', responsibilities: [], requirements },
    questions,
    flashcards: [],
    schedule: buildSchedule(questions, requirements, 2),
    coverage: { uncovered_requirement_ids: [], passes: 1 },
    warnings: [],
  };
}

function cloneKit(kit: Kit): Kit {
  return structuredClone(kit);
}

describe('mergeRegeneratedSection - concurrent question edits during regeneration', () => {
  it('keeps an edit made to a question while the regeneration was running', () => {
    const snapshot = kitWith([
      q('q1', 'technical', ['r1']),
      q('q2', 'technical', ['r1']),
    ]);
    // while regen ran, the user edited q2 (flips item_state and prompt)
    const fresh = cloneKit(snapshot);
    const editedQ2 = fresh.questions.find((x) => x.id === 'q2')!;
    editedQ2.prompt = 'EDITED DURING REGEN';
    editedQ2.item_state = 'edited';
    // pipeline result built from the snapshot: both pristine items replaced
    const result = cloneKit(snapshot);
    result.questions = [q('q3', 'technical', ['r1']), q('q4', 'technical', ['r1'])];

    const merged = mergeRegeneratedSection(fresh, snapshot, result, 'technical');

    const ids = merged.questions.map((x) => x.id).sort();
    expect(ids).toEqual(['q2', 'q3', 'q4']); // q1 (still pristine) replaced
    const kept = merged.questions.find((x) => x.id === 'q2')!;
    expect(kept.prompt).toBe('EDITED DURING REGEN');
    expect(kept.item_state).toBe('edited');
  });

  it('keeps a question added manually during the regeneration and re-ids a colliding regenerated item', () => {
    const snapshot = kitWith([q('q1', 'technical', ['r1']), q('q2', 'behavioural', ['r2'])]);
    const fresh = cloneKit(snapshot);
    fresh.questions.push(q('q3', 'technical', ['r1'], { origin: 'manual', prompt: 'MY MANUAL QUESTION' }));
    // pipeline (working from the snapshot, where q3 does not exist) also picks q3 as the next free id
    const result = cloneKit(snapshot);
    result.questions = [...snapshot.questions, q('q3', 'technical', ['r1'])];

    const merged = mergeRegeneratedSection(fresh, snapshot, result, 'technical');

    const prompts = merged.questions.map((x) => x.prompt);
    expect(prompts).toContain('MY MANUAL QUESTION'); // user's q3 survived
    expect(merged.questions.filter((x) => x.prompt === 'Prompt q3')).toHaveLength(1); // regen item kept too
    const ids = merged.questions.map((x) => x.id);
    expect(new Set(ids).size).toBe(ids.length); // no id collision
  });

  it('does not resurrect a question deleted during the regeneration', () => {
    const snapshot = kitWith([
      q('q1', 'technical', ['r1']),
      q('q2', 'behavioural', ['r2'], { origin: 'manual' }),
    ]);
    const fresh = cloneKit(snapshot);
    fresh.questions = fresh.questions.filter((x) => x.id !== 'q2'); // user deleted it mid-run
    // realistic pipeline output: q2 kept from the snapshot, q1 replaced by a new id
    const result = cloneKit(snapshot);
    result.questions = [q('q2', 'behavioural', ['r2'], { origin: 'manual' }), q('q3', 'technical', ['r1'])];

    const merged = mergeRegeneratedSection(fresh, snapshot, result, 'technical');

    expect(merged.questions.some((x) => x.id === 'q2')).toBe(false); // deletion stands
    expect(merged.questions.map((x) => x.id)).toEqual(['q3']); // pristine q1 was replaced
  });

  it('repairs the schedule for replaced and added ids', () => {
    const snapshot = kitWith([q('q1', 'technical', ['r1']), q('q2', 'behavioural', ['r2'])]);
    const fresh = cloneKit(snapshot);
    const result = cloneKit(snapshot);
    result.questions = [q('q2', 'behavioural', ['r2']), q('q9', 'technical', ['r1'])];

    const merged = mergeRegeneratedSection(fresh, snapshot, result, 'technical');

    const scheduled = merged.schedule.days.flatMap((d) => d.question_ids);
    expect(scheduled).not.toContain('q1');
    expect(scheduled).toContain('q9');
    expect(merged.coverage.uncovered_requirement_ids).toEqual([]); // q9 covers r1
  });
});

describe('mergeRegeneratedSection - concurrent brief edits', () => {
  it('applies the regenerated brief when the user did not touch it', () => {
    const snapshot = kitWith([], { summary: 'old', what_they_do: 'old' });
    const fresh = cloneKit(snapshot);
    const result = cloneKit(snapshot);
    result.company_brief.summary = 'REGENERATED';
    const merged = mergeRegeneratedSection(fresh, snapshot, result, 'brief');
    expect(merged.company_brief.summary).toBe('REGENERATED');
  });

  it('keeps the user-edited brief when they edited it during the run', () => {
    const snapshot = kitWith([], { summary: 'old', what_they_do: 'old' });
    const fresh = cloneKit(snapshot);
    fresh.company_brief.summary = 'MY OWN WORDS';
    const result = cloneKit(snapshot);
    result.company_brief.summary = 'REGENERATED';
    const merged = mergeRegeneratedSection(fresh, snapshot, result, 'brief');
    expect(merged.company_brief.summary).toBe('MY OWN WORDS');
  });
});
