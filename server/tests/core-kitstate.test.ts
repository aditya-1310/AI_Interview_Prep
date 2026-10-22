import { describe, expect, it } from 'vitest';
import type { Kit, Question } from '../src/core/types';
import {
  addManualQuestion,
  applyQuestionEdit,
  deleteQuestion,
  deleteRequirement,
  mergeRegeneratedQuestions,
  reorderQuestions,
  repairScheduleAfterRegen,
  togglePin,
} from '../src/core/kitState';
import { buildSchedule } from '../src/core/schedule';

function q(id: string, category: Question['category'], requirement_ids: string[], overrides: Partial<Question> = {}): Question {
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

function kit(): Kit {
  const questions = [
    q('q1', 'technical', ['r1']),
    q('q2', 'technical', ['r1']),
    q('q3', 'behavioural', ['r2']),
    q('q4', 'company-fit', ['r2']),
  ];
  return {
    source: { company: 'Acme', company_url: 'https://acme.example', role: 'Eng', location: '', jd_chars: 10, researched_at: '2026-10-22T00:00:00Z', pages_used: [] },
    company_brief: { summary: '', what_they_do: '', sources: [] },
    role: {
      title: 'Eng', seniority: 'mid', responsibilities: [],
      requirements: [
        { id: 'r1', text: 'React', kind: 'technical', priority: 'must' },
        { id: 'r2', text: 'Mentoring', kind: 'behavioural', priority: 'must' },
      ],
    },
    questions,
    flashcards: [],
    schedule: buildSchedule(questions, [
      { id: 'r1', text: 'React', kind: 'technical', priority: 'must' },
      { id: 'r2', text: 'Mentoring', kind: 'behavioural', priority: 'must' },
    ], 2),
    coverage: { uncovered_requirement_ids: [], passes: 1 },
    warnings: [],
  };
}

function regeneratedIncoming(): Question[] {
  return [
    q('q1', 'technical', ['r1']), // fresh from the model, same content shape
    q('q2', 'technical', ['r1']),
    q('q3', 'technical', ['r1']),
  ];
}

describe('regeneration merge', () => {
  it('replaces pristine generated items but keeps manual, edited and pinned ones', () => {
    const k = kit();
    (k.questions[0] as Question).origin = 'manual';
    (k.questions[1] as Question).item_state = 'edited';
    (k.questions[3] as Question).pinned = true;
    const merged = mergeRegeneratedQuestions(k, 'technical', regeneratedIncoming());
    const ids = merged.map((x) => x.id);
    // q1 (manual) and q2 (edited) survive; pristine technical q... none existed pristine; q4 untouched in other category
    expect(ids).toContain('q1');
    expect(ids).toContain('q2');
    expect(ids).toContain('q4');
    const fresh = merged.filter((x) => x.origin === 'generated' && x.item_state === 'pristine' && x.category === 'technical');
    expect(fresh).toHaveLength(3);
  });

  it('regenerated items get fresh unique ids and never collide', () => {
    const k = kit();
    const merged = mergeRegeneratedQuestions(k, 'technical', regeneratedIncoming());
    const ids = merged.map((x) => x.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('kept items keep their exact id', () => {
    const k = kit();
    (k.questions[0] as Question).origin = 'manual';
    const merged = mergeRegeneratedQuestions(k, 'technical', regeneratedIncoming());
    expect(merged.find((x) => x.id === 'q1')?.origin).toBe('manual');
  });
});

describe('edits and deletions', () => {
  it('inline edit flips item_state to edited', () => {
    const k = kit();
    applyQuestionEdit(k, 'q1', { prompt: 'New prompt' });
    expect(k.questions[0].item_state).toBe('edited');
    expect(k.questions[0].prompt).toBe('New prompt');
  });

  it('manual questions get unique ids and manual origin', () => {
    const k = kit();
    const added = addManualQuestion(k, { category: 'technical', prompt: 'My question', answer_outline: '', difficulty: 1, requirement_ids: ['r1'] });
    expect(added.id).toBe('q5');
    expect(added.origin).toBe('manual');
  });

  it('deleting a question repairs the schedule and coverage', () => {
    const k = kit();
    deleteQuestion(k, 'q3');
    expect(k.questions.find((x) => x.id === 'q3')).toBeUndefined();
    for (const day of k.schedule.days) {
      expect(day.question_ids).not.toContain('q3');
    }
    // r2 still covered by q4
    expect(k.coverage.uncovered_requirement_ids).toEqual([]);
    // deleting q4 as well uncovers r2
    deleteQuestion(k, 'q4');
    expect(k.coverage.uncovered_requirement_ids).toEqual(['r2']);
  });

  it('a day emptied by deletion is rebuilt, not left invalid', () => {
    const k = kit();
    // 1-day schedule puts everything on day 1; delete enough to still have questions
    k.schedule = buildSchedule(k.questions, k.role.requirements, 1);
    deleteQuestion(k, 'q1');
    expect(k.schedule.days).toHaveLength(1);
    expect(k.schedule.days[0].question_ids.length).toBeGreaterThan(0);
  });

  it('deleting a requirement strips its references everywhere', () => {
    const k = kit();
    deleteRequirement(k, 'r1');
    expect(k.role.requirements.find((r) => r.id === 'r1')).toBeUndefined();
    for (const question of k.questions) expect(question.requirement_ids).not.toContain('r1');
  });

  it('reorder applies the given order and keeps unknown ids out', () => {
    const k = kit();
    reorderQuestions(k, ['q3', 'q1', 'q2', 'q4']);
    expect(k.questions.map((x) => x.id)).toEqual(['q3', 'q1', 'q2', 'q4']);
    reorderQuestions(k, ['q2', 'qX']);
    expect(k.questions.map((x) => x.id)).toEqual(['q2', 'q3', 'q1', 'q4']);
  });

  it('pin toggles', () => {
    const k = kit();
    togglePin(k, 'question', 'q1');
    expect(k.questions[0].pinned).toBe(true);
    togglePin(k, 'question', 'q1');
    expect(k.questions[0].pinned).toBe(false);
  });
});

describe('schedule repair after regeneration', () => {
  it('drops removed ids, places new ids and keeps the day count stable', () => {
    const k = kit();
    // simulate the pipeline having merged a regenerated question into the kit
    addManualQuestion(k, { category: 'technical', prompt: 'Fresh question', answer_outline: '', difficulty: 2, requirement_ids: ['r1'] });
    const daysBefore = k.schedule.days.length;
    const focusBefore = k.schedule.days.map((d) => d.focus);
    repairScheduleAfterRegen(k, ['q1'], ['q5']);
    expect(k.schedule.days).toHaveLength(daysBefore);
    for (const day of k.schedule.days) expect(day.question_ids).not.toContain('q1');
    const scheduled = k.schedule.days.flatMap((d) => d.question_ids);
    expect(scheduled).toContain('q5');
    expect(Number.isInteger(k.schedule.days[0].minutes)).toBe(true);
    // untouched focus text survives
    expect(k.schedule.days.map((d) => d.focus)).toEqual(focusBefore);
  });

  it('rebuilds only when a day is left empty', () => {
    const k = kit();
    const q1 = k.questions.find((x) => x.id === 'q1')!;
    (q1 as { item_state: string }).item_state = 'edited';
    const before = JSON.stringify(k.schedule.days.map((d) => d.focus));
    repairScheduleAfterRegen(k, [], []);
    expect(JSON.stringify(k.schedule.days.map((d) => d.focus))).toBe(before);
  });
});
