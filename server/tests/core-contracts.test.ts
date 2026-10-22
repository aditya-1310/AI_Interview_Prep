import { describe, expect, it } from 'vitest';
import type { Kit } from '../src/core/types';
import { batchOutputSchema, kitSchema } from '../src/core/schemas';

function validKit(): Kit {
  return {
    source: {
      company: 'Acme',
      company_url: 'https://acme.example',
      role: 'Senior Engineer',
      location: 'Remote',
      jd_chars: 1200,
      researched_at: '2026-10-22T10:00:00Z',
      pages_used: ['https://acme.example/about'],
    },
    company_brief: {
      summary: 'Acme builds widgets.',
      what_they_do: 'Widget manufacturing.',
      sources: ['https://acme.example/about'],
    },
    role: {
      title: 'Senior Engineer',
      seniority: 'senior',
      responsibilities: ['Build features'],
      requirements: [
        { id: 'r1', text: '5+ years React', kind: 'technical', priority: 'must' },
        { id: 'r2', text: 'Mentoring', kind: 'behavioural', priority: 'nice' },
      ],
    },
    questions: [
      {
        id: 'q1',
        requirement_ids: ['r1'],
        category: 'technical',
        prompt: 'Explain React reconciliation.',
        answer_outline: 'Virtual DOM, diffing...',
        difficulty: 2,
        origin: 'generated',
        item_state: 'pristine',
        pinned: false,
      },
    ],
    flashcards: [
      { id: 'f1', front: 'What is XSS?', back: 'Injection attack...', requirement_ids: ['r1'], origin: 'generated', item_state: 'pristine', pinned: false },
    ],
    schedule: {
      days_available: 2,
      days: [
        { day: 1, focus: 'Technical practice: 5+ years React', question_ids: ['q1'], minutes: 30 },
        { day: 2, focus: 'Review: 5+ years React', question_ids: ['q1'], minutes: 15 },
      ],
    },
    coverage: { uncovered_requirement_ids: [], passes: 1 },
    warnings: [],
  };
}

describe('kit structure validation', () => {
  it('accepts a contract-shaped kit', () => {
    expect(kitSchema.safeParse(validKit()).success).toBe(true);
  });

  it('rejects camelCase drift on exact field names', () => {
    const kit = validKit();
    (kit.questions[0] as unknown as Record<string, unknown>).answerOutline = 'oops';
    const parsed = kitSchema.safeParse(kit);
    expect(parsed.success).toBe(false);
  });

  it('rejects difficulty outside 1..3 or non-integer', () => {
    const kit = validKit();
    (kit.questions[0] as { difficulty: number }).difficulty = 4;
    expect(kitSchema.safeParse(kit).success).toBe(false);
    const kit2 = validKit();
    (kit2.questions[0] as { difficulty: number }).difficulty = 2.5;
    expect(kitSchema.safeParse(kit2).success).toBe(false);
  });

  it('rejects non-integer minutes', () => {
    const kit = validKit();
    (kit.schedule.days[0] as { minutes: number }).minutes = 30.5;
    expect(kitSchema.safeParse(kit).success).toBe(false);
  });

  it('rejects an invalid category enum', () => {
    const kit = validKit();
    (kit.questions[0] as { category: string }).category = 'coding';
    expect(kitSchema.safeParse(kit).success).toBe(false);
  });
});

describe('batch output envelope', () => {
  it('accepts a mixed ok/failed envelope', () => {
    const envelope = {
      version: '1.0',
      generated_at: '2026-10-22T10:00:00Z',
      kits: [
        { id: 'case-01', status: 'ok', kit: validKit(), error: null },
        { id: 'case-02', status: 'failed', kit: null, error: { code: 'COMPANY_UNREACHABLE', message: 'unreachable after retries' } },
      ],
    };
    expect(batchOutputSchema.safeParse(envelope).success).toBe(true);
  });

  it('rejects the wrong envelope version', () => {
    const envelope = {
      version: '2.0',
      generated_at: '2026-10-22T10:00:00Z',
      kits: [],
    };
    expect(batchOutputSchema.safeParse(envelope).success).toBe(false);
  });
});
