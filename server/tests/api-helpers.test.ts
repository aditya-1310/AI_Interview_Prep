// Pure unit tests for API-layer helpers. No network, no Mongo connection.
import { describe, expect, it } from 'vitest';
import { inputHashFor, Kit } from '../src/models/Kit';
import { baseVersionConflict } from '../src/routes/kits';
import { kitVisibleTo } from '../src/middleware/loadKit';
import { mergeRegeneratedSection } from '../src/jobs/runner';
import type { Flashcard, KitDocument, Question } from '../src/core/types';

const JD = 'We are looking for a backend engineer with Node.js experience.';
const URL = 'https://acme.example/careers';

describe('inputHashFor', () => {
  it('is deterministic for identical input', () => {
    const a = inputHashFor(JD, URL, 5);
    const b = inputHashFor(JD, URL, 5);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{40}$/);
  });

  it('changes when any component changes', () => {
    const base = inputHashFor(JD, URL, 5);
    expect(inputHashFor(`${JD} `, URL, 5)).not.toBe(base);
    expect(inputHashFor(JD, `${URL}/`, 5)).not.toBe(base);
    expect(inputHashFor(JD, URL, 7)).not.toBe(base);
  });

  it('matches the Kit model static', () => {
    expect(Kit.inputHashFor(JD, URL, 5)).toBe(inputHashFor(JD, URL, 5));
  });
});

describe('baseVersionConflict', () => {
  it('accepts when baseVersion is omitted', () => {
    expect(baseVersionConflict(3, undefined)).toBe(false);
  });

  it('accepts when baseVersion matches the current version', () => {
    expect(baseVersionConflict(3, 3)).toBe(false);
  });

  it('conflicts when baseVersion differs (stale or ahead)', () => {
    expect(baseVersionConflict(3, 2)).toBe(true);
    expect(baseVersionConflict(3, 4)).toBe(true);
  });
});

describe('kitVisibleTo (ownership)', () => {
  it('sees own kit', () => {
    expect(kitVisibleTo({ userId: 'u1' }, 'u1')).toBe(true);
  });

  it('never sees another user kit, a missing kit, or without a session', () => {
    expect(kitVisibleTo({ userId: 'u2' }, 'u1')).toBe(false);
    expect(kitVisibleTo(null, 'u1')).toBe(false);
    expect(kitVisibleTo(undefined, 'u1')).toBe(false);
    expect(kitVisibleTo({ userId: 'u1' }, undefined)).toBe(false);
    expect(kitVisibleTo(null, null)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// mergeRegeneratedSection: regeneration results are merged onto the FRESHEST
// document state, section-scoped, so concurrent user edits always win.
// ---------------------------------------------------------------------------

function question(id: string, category: Question['category']): Question {
  return {
    id,
    requirement_ids: ['r1'],
    category,
    prompt: `Prompt ${id}`,
    answer_outline: 'outline',
    difficulty: 2,
    origin: 'generated',
    item_state: 'pristine',
    pinned: false,
  };
}

function flashcard(id: string): Flashcard {
  return {
    id,
    front: `Front ${id}`,
    back: `Back ${id}`,
    requirement_ids: ['r1'],
    origin: 'manual',
    item_state: 'pristine',
    pinned: false,
  };
}

function baseKit(): KitDocument {
  return {
    source: {
      company: 'Acme',
      company_url: 'https://acme.example',
      role: 'Engineer',
      location: '',
      jd_chars: 100,
      researched_at: '2026-10-22T00:00:00.000Z',
      pages_used: [],
    },
    company_brief: { summary: 'old summary', what_they_do: 'old', sources: [] },
    role: {
      title: 'Engineer',
      seniority: 'Mid',
      responsibilities: [],
      requirements: [{ id: 'r1', text: 'Knows Node', kind: 'technical', priority: 'must' }],
    },
    questions: [question('q1', 'technical'), question('q2', 'behavioural')],
    flashcards: [flashcard('f1')],
    schedule: {
      days_available: 2,
      days: [
        { day: 1, focus: 'Technical', question_ids: ['q1'], minutes: 30 },
        { day: 2, focus: 'Behavioural', question_ids: ['q2'], minutes: 30 },
      ],
    },
    coverage: { uncovered_requirement_ids: [], passes: 1 },
    warnings: [],
  };
}

function cloneKit(kit: KitDocument): KitDocument {
  return structuredClone(kit);
}

describe('mergeRegeneratedSection', () => {
  it('replaces only the regenerated category and repairs the schedule', () => {
    const snapshot = baseKit();
    // Pipeline result: technical category regenerated - q1 out, q3 in.
    const result = cloneKit(snapshot);
    result.questions = [question('q3', 'technical'), snapshot.questions[1]];
    result.warnings = [{ code: 'RESEARCH_GAP', message: 'no hiring page found' }];

    // Fresh doc: user added a manual flashcard while the job ran.
    const fresh = cloneKit(snapshot);
    fresh.flashcards.push(flashcard('f9'));

    const merged = mergeRegeneratedSection(fresh, snapshot, result, 'technical');

    const ids = merged.questions.map((q) => q.id).sort();
    expect(ids).toEqual(['q2', 'q3']);
    expect(merged.flashcards.map((f) => f.id)).toEqual(['f1', 'f9']); // user edit survived
    // Schedule repaired: no dangling q1, new q3 scheduled somewhere.
    const scheduled = merged.schedule.days.flatMap((d) => d.question_ids);
    expect(scheduled).not.toContain('q1');
    expect(scheduled).toContain('q3');
    expect(scheduled).toContain('q2');
    // Coverage recomputed against the final requirement/question set.
    expect(merged.coverage.uncovered_requirement_ids).toEqual([]);
    // Warnings merged, no duplicates on repeated merges.
    expect(merged.warnings).toHaveLength(1);
    const mergedAgain = mergeRegeneratedSection(merged, snapshot, result, 'technical');
    expect(mergedAgain.warnings).toHaveLength(1);
  });

  it('replaces only the brief for section=brief', () => {
    const snapshot = baseKit();
    const result = cloneKit(snapshot);
    result.company_brief = { summary: 'new summary', what_they_do: 'new', sources: ['s1'] };
    const fresh = cloneKit(snapshot);
    fresh.role.title = 'Staff Engineer'; // concurrent user edit

    const merged = mergeRegeneratedSection(fresh, snapshot, result, 'brief');
    expect(merged.company_brief.summary).toBe('new summary');
    expect(merged.role.title).toBe('Staff Engineer'); // untouched section survives
    expect(merged.questions.map((q) => q.id)).toEqual(['q1', 'q2']);
  });

  it('replaces only the schedule for section=schedule', () => {
    const snapshot = baseKit();
    const result = cloneKit(snapshot);
    result.schedule = {
      days_available: 3,
      days: [
        { day: 1, focus: 'A', question_ids: ['q1'], minutes: 30 },
        { day: 2, focus: 'B', question_ids: ['q2'], minutes: 30 },
        { day: 3, focus: 'Review', question_ids: ['q1'], minutes: 15 },
      ],
    };
    const fresh = cloneKit(snapshot);
    fresh.questions[0].item_state = 'edited'; // concurrent user edit

    const merged = mergeRegeneratedSection(fresh, snapshot, result, 'schedule');
    expect(merged.schedule.days).toHaveLength(3);
    expect(merged.questions[0].item_state).toBe('edited');
  });
});
