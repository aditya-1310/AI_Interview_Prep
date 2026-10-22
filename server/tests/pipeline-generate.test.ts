import { describe, expect, it } from 'vitest';
import { companyBrief, normalizeFlashcards, normalizeQuestions } from '../src/services/generate';
import { FakeLlm } from './helpers/fakes';

const VALID_IDS = new Set(['r1', 'r2', 'r3']);

describe('question normalisation (code, never the model)', () => {
  it('keeps valid references, trims dangling ones and drops fully-dangling questions', () => {
    const raw = {
      questions: [
        { requirement_ids: ['r1', 'rX'], prompt: 'Explain React reconciliation and when it matters.', answer_outline: 'a', difficulty: 2 },
        { requirement_ids: ['rZ'], prompt: 'This question only references junk ids.', answer_outline: 'b', difficulty: 1 }, // dropped
        { requirement_ids: ['r2'], prompt: 'Tell me about mentoring a junior engineer.', answer_outline: 'c', difficulty: 9 }, // clamped to 3
        { requirement_ids: [], prompt: 'A general question with no references is allowed.', answer_outline: 'd', difficulty: 1 },
      ],
    };
    const out = normalizeQuestions(raw, 'behavioural', VALID_IDS);
    expect(out).toHaveLength(3);
    expect(out[0].requirement_ids).toEqual(['r1']); // dangling rX stripped
    expect(out[0].category).toBe('behavioural'); // category forced by code
    expect(out[1].difficulty).toBe(3);
    expect(out[2].requirement_ids).toEqual([]);
  });

  it('dedupes duplicate prompts and drops prompts that are too short', () => {
    const raw = {
      questions: [
        { requirement_ids: ['r1'], prompt: 'Design a rate limiter for a public API.', answer_outline: 'x', difficulty: 3 },
        { requirement_ids: ['r2'], prompt: 'Design a rate limiter for a public API.', answer_outline: 'x', difficulty: 2 }, // dupe
        { requirement_ids: ['r1'], prompt: 'hi', answer_outline: 'x', difficulty: 2 }, // too short
      ],
    };
    expect(normalizeQuestions(raw, 'system-design', VALID_IDS)).toHaveLength(1);
  });

  it('survives garbage shapes via the lenient zod schema', () => {
    expect(normalizeQuestions({ questions: 'nope' }, 'technical', VALID_IDS)).toEqual([]);
    expect(normalizeQuestions(null, 'technical', VALID_IDS)).toEqual([]);
    expect(
      normalizeQuestions(
        { questions: [{ requirement_ids: 'r1', prompt: 'Valid prompt about SQL indexes and query plans.', answer_outline: '', difficulty: '2' }] },
        'technical',
        VALID_IDS,
      ),
    ).toHaveLength(1);
  });
});

describe('flashcard normalisation', () => {
  it('filters dangling references and drops cards without any valid reference', () => {
    const raw = {
      flashcards: [
        { front: 'What is an index-only scan?', back: 'A query answered from the index alone.', requirement_ids: ['r3', 'rX'] },
        { front: 'Garbage?', back: 'x', requirement_ids: ['rX'] }, // dropped
        { front: 'What does EXPLAIN show?', back: 'The query plan.', requirement_ids: [] },
      ],
    };
    const out = normalizeFlashcards(raw, VALID_IDS);
    expect(out).toHaveLength(2);
    expect(out[0].requirement_ids).toEqual(['r3']);
    expect(out[1].requirement_ids).toEqual([]);
  });
});

describe('company brief honesty', () => {
  it('returns an honest deterministic brief when no research was retrieved', async () => {
    const llm = new FakeLlm({});
    const { brief, warnings } = await companyBrief(
      llm,
      { pages: [], hiringPages: [], infoPages: [], company: 'Ghost Corp', warnings: [] },
      { items: [], warnings: [] },
      { company: 'Ghost Corp', roleTitle: 'Engineer' },
    );
    expect(llm.calls).toHaveLength(0); // no wasted LLM call on empty research
    expect(brief.sources).toEqual([]);
    expect(brief.summary).toContain('Ghost Corp');
    expect(brief.summary.toLowerCase()).toContain('no usable research');
    expect(warnings.some((w) => w.code === 'NO_COMPANY_RESEARCH')).toBe(true);
  });

  it('feeds the pages actually used and records their URLs as sources', async () => {
    const llm = new FakeLlm({
      'company brief': () => ({ summary: 'Acme builds analytics tooling.', what_they_do: 'A product telemetry platform.' }),
    });
    const crawl = {
      pages: [
        { url: 'http://f.test/about.html', title: 'About', text: 'Our story.' },
        { url: 'http://f.test/careers.html', title: 'Careers', text: 'How we hire.' },
      ],
      hiringPages: [{ url: 'http://f.test/careers.html', title: 'Careers', text: 'How we hire.' }],
      infoPages: [{ url: 'http://f.test/about.html', title: 'About', text: 'Our story.' }],
      company: 'Acme',
      warnings: [],
    };
    const { brief } = await companyBrief(llm, crawl, { items: [], warnings: [] }, { company: 'Acme', roleTitle: 'Eng' });
    expect(brief.summary).toBe('Acme builds analytics tooling.');
    expect(brief.sources).toEqual(['http://f.test/careers.html', 'http://f.test/about.html']); // hiring first
    const prompt = llm.calls[0].prompt;
    expect(prompt).toContain('How we hire.');
    expect(prompt).toContain('UNTRUSTED CONTENT');
  });

  it('falls back honestly when the brief call itself fails', async () => {
    const llm = new FakeLlm((schemaName) => {
      if (schemaName === 'company brief') throw new Error('model exploded');
      return {};
    });
    const crawl = {
      pages: [{ url: 'http://f.test/', title: 'Home', text: 'hello' }],
      hiringPages: [],
      infoPages: [{ url: 'http://f.test/', title: 'Home', text: 'hello' }],
      company: 'Acme',
      warnings: [],
    };
    const { brief, warnings } = await companyBrief(llm, crawl, { items: [], warnings: [] }, { company: 'Acme', roleTitle: 'E' });
    expect(warnings.some((w) => w.code === 'BRIEF_FAILED')).toBe(true);
    expect(warnings.find((w) => w.code === 'BRIEF_FAILED')?.message).not.toMatch(/HTTP|gemini|model/i);
    expect(brief.summary.toLowerCase()).toContain('ai service was unavailable');
  });
});
