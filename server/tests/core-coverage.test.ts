import { describe, expect, it } from 'vitest';
import type { Kit, Question, Requirement } from '../src/core/types';
import { computeCoverage, stripDanglingRefs, uncoveredRequirementIds, categoryForRequirement } from '../src/core/coverage';

function requirements(): Requirement[] {
  return [
    { id: 'r1', text: 'React experience', kind: 'technical', priority: 'must' },
    { id: 'r2', text: 'Mentoring', kind: 'behavioural', priority: 'must' },
    { id: 'r3', text: 'Kubernetes', kind: 'technical', priority: 'nice' },
    { id: 'r4', text: 'Payments domain', kind: 'domain', priority: 'must' },
  ];
}

function question(id: string, requirement_ids: string[]): Question {
  return {
    id,
    requirement_ids,
    category: 'technical',
    prompt: `Prompt ${id}`,
    answer_outline: '',
    difficulty: 2,
    origin: 'generated',
    item_state: 'pristine',
    pinned: false,
  };
}

function kitWith(questions: Question[]): Kit {
  return {
    source: {
      company: 'Acme', company_url: 'https://acme.example', role: 'Engineer', location: '',
      jd_chars: 100, researched_at: '2026-10-22T00:00:00Z', pages_used: [],
    },
    company_brief: { summary: '', what_they_do: '', sources: [] },
    role: { title: 'Engineer', seniority: 'senior', responsibilities: [], requirements: requirements() },
    questions,
    flashcards: [],
    schedule: { days_available: 3, days: [{ day: 1, focus: 'x', question_ids: [], minutes: 30 }] },
    coverage: { uncovered_requirement_ids: [], passes: 1 },
    warnings: [],
  };
}

describe('coverage checking', () => {
  it('flags must-have requirements with no question', () => {
    const kit = kitWith([question('q1', ['r1'])]);
    expect(uncoveredRequirementIds(kit, 'must')).toEqual(['r2', 'r4']);
  });

  it('a must-have is covered once any question references it', () => {
    const kit = kitWith([question('q1', ['r1']), question('q2', ['r2']), question('q3', ['r1', 'r4'])]);
    expect(uncoveredRequirementIds(kit, 'must')).toEqual([]);
  });

  it('nice-to-have gaps are reported separately and never block', () => {
    const kit = kitWith([question('q1', ['r1']), question('q2', ['r2']), question('q3', ['r4'])]);
    expect(uncoveredRequirementIds(kit, 'must')).toEqual([]);
    expect(uncoveredRequirementIds(kit, 'nice')).toEqual(['r3']);
  });

  it('strips dangling requirement references before judging coverage', () => {
    const kit = kitWith([question('q1', ['r1', 'rX'])]);
    stripDanglingRefs(kit);
    expect(kit.questions[0].requirement_ids).toEqual(['r1']);
    expect(uncoveredRequirementIds(kit, 'must')).toEqual(['r2', 'r4']);
  });

  it('records the pass count', () => {
    const kit = kitWith([question('q1', ['r1', 'r2', 'r4'])]);
    expect(computeCoverage(kit, 2)).toEqual({ uncovered_requirement_ids: [], passes: 2 });
  });

  it('maps requirement kinds to gap-fill categories deterministically', () => {
    expect(categoryForRequirement(requirements()[0])).toBe('technical');
    expect(categoryForRequirement(requirements()[1])).toBe('behavioural');
    expect(categoryForRequirement(requirements()[3])).toBe('technical');
  });
});
