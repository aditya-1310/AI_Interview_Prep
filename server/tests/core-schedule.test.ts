import { describe, expect, it } from 'vitest';
import type { Kit, Question, Requirement } from '../src/core/types';
import { buildSchedule, orderQuestions } from '../src/core/schedule';

function req(id: string, priority: Requirement['priority'] = 'must'): Requirement {
  return { id, text: `Requirement ${id}`, kind: 'technical', priority };
}

function question(
  id: string,
  opts: Partial<Question> = {},
): Question {
  return {
    id,
    requirement_ids: [`r${id.slice(1)}`],
    category: 'technical',
    prompt: `Prompt ${id}`,
    answer_outline: 'outline',
    difficulty: 2,
    origin: 'generated',
    item_state: 'pristine',
    pinned: false,
    ...opts,
  };
}

function fixture(): { questions: Question[]; requirements: Requirement[] } {
  const requirements: Requirement[] = [
    req('r1'),
    req('r2'),
    req('r3', 'nice'),
    req('r4'),
    req('r5', 'nice'),
  ];
  const questions: Question[] = [
    question('q1', { requirement_ids: ['r1'], difficulty: 2, category: 'technical' }),
    question('q2', { requirement_ids: ['r3'], difficulty: 1, category: 'technical' }),
    question('q3', { requirement_ids: ['r2'], difficulty: 3, category: 'system-design' }),
    question('q4', { requirement_ids: ['r4'], difficulty: 2, category: 'behavioural' }),
    question('q5', { requirement_ids: ['r5'], difficulty: 1, category: 'company-fit' }),
    question('q6', { requirement_ids: ['r1'], difficulty: 3, category: 'technical' }),
    question('q7', { requirement_ids: [], difficulty: 1, category: 'behavioural' }),
    question('q8', { requirement_ids: ['r2'], difficulty: 2, category: 'company-fit' }),
    question('q9', { requirement_ids: ['r4'], difficulty: 3, category: 'system-design' }),
    question('q10', { requirement_ids: ['r5'], difficulty: 2, category: 'technical' }),
  ];
  return { questions, requirements };
}

describe('schedule allocation', () => {
  it('produces exactly the requested number of days for 1, 5, 13 and 60 days', () => {
    const { questions, requirements } = fixture();
    for (const days of [1, 5, 13, 60]) {
      const s = buildSchedule(questions, requirements, days);
      expect(s.days_available).toBe(days);
      expect(s.days).toHaveLength(days);
      expect(s.days.map((d) => d.day)).toEqual(Array.from({ length: days }, (_, i) => i + 1));
    }
  });

  it('every day has a focus, valid question ids and positive integer minutes', () => {
    const { questions, requirements } = fixture();
    const s = buildSchedule(questions, requirements, 5);
    const ids = new Set(questions.map((q) => q.id));
    for (const day of s.days) {
      expect(day.focus.length).toBeGreaterThan(0);
      for (const id of day.question_ids) expect(ids.has(id)).toBe(true);
      expect(Number.isInteger(day.minutes)).toBe(true);
      expect(day.minutes).toBeGreaterThan(0);
    }
  });

  it('schedules every question exactly once when days <= questions', () => {
    const { questions, requirements } = fixture();
    const s = buildSchedule(questions, requirements, 4);
    const scheduled = s.days.flatMap((d) => d.question_ids).sort();
    expect(scheduled).toEqual([...scheduled].sort());
    expect(new Set(scheduled).size).toBe(questions.length);
    expect(scheduled).toHaveLength(questions.length);
  });

  it('harder, must-have material lands on day 1', () => {
    const { questions, requirements } = fixture();
    const s = buildSchedule(questions, requirements, 5);
    const day1Ids = new Set(s.days[0].question_ids);
    // q6 and q9 are difficulty 3 covering must-haves -> earliest tier
    expect(day1Ids.has('q6') || day1Ids.has('q9')).toBe(true);
  });

  it('nice-only questions come after must-covering ones in ordering', () => {
    const { questions, requirements } = fixture();
    const ordered = orderQuestions(questions, requirements);
    const firstNiceIdx = ordered.findIndex((q) => q.requirement_ids.length > 0 && q.requirement_ids.every((id) => requirements.find((r) => r.id === id)?.priority === 'nice'));
    const lastMustIdx = ordered.map((q) => q.requirement_ids.some((id) => requirements.find((r) => r.id === id)?.priority === 'must')).lastIndexOf(true);
    expect(firstNiceIdx).toBeGreaterThan(lastMustIdx);
  });

  it('more days than questions yields material days then spaced review days', () => {
    const { questions, requirements } = fixture();
    const three = questions.slice(0, 3);
    const s = buildSchedule(three, requirements, 7);
    expect(s.days).toHaveLength(7);
    // first 3 days are material days with one question each
    for (let i = 0; i < 3; i++) expect(s.days[i].question_ids).toHaveLength(1);
    // review days reference existing questions with halved integer minutes
    const ids = new Set(three.map((q) => q.id));
    for (const day of s.days.slice(3)) {
      expect(day.question_ids.length).toBeGreaterThanOrEqual(1);
      for (const id of day.question_ids) expect(ids.has(id)).toBe(true);
      expect(Number.isInteger(day.minutes)).toBe(true);
      expect(day.minutes).toBeLessThan(46);
    }
  });

  it('a single question across 60 days stays valid', () => {
    const { requirements } = fixture();
    const one = [question('q1', { requirement_ids: ['r1'], difficulty: 3 })];
    const s = buildSchedule(one, requirements, 60);
    expect(s.days).toHaveLength(60);
    expect(s.days[0].minutes).toBe(45);
    expect(s.days[59].focus.startsWith('Review')).toBe(true);
  });

  it('zero questions produce honest reading days rather than crashing', () => {
    const { requirements } = fixture();
    const s = buildSchedule([], requirements, 3);
    expect(s.days).toHaveLength(3);
    for (const day of s.days) {
      expect(day.question_ids).toEqual([]);
      expect(day.focus.length).toBeGreaterThan(0);
      expect(day.minutes).toBe(30);
    }
  });

  it('is deterministic - same input, same output', () => {
    const { questions, requirements } = fixture();
    const a = buildSchedule(questions, requirements, 5);
    const b = buildSchedule(questions, requirements, 5);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('rejects out-of-range day counts', () => {
    const { questions, requirements } = fixture();
    expect(() => buildSchedule(questions, requirements, 0)).toThrow(RangeError);
    expect(() => buildSchedule(questions, requirements, 61)).toThrow(RangeError);
    expect(() => buildSchedule(questions, requirements, 2.5)).toThrow(RangeError);
  });
});
