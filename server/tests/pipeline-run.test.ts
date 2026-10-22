import { describe, expect, it } from 'vitest';
import { PipelineError } from '../src/core/ports';
import { kitSchema } from '../src/core/schemas';
import { createKitGenerator } from '../src/services/pipeline';
import type { PipelineDeps } from '../src/services/pipeline';
import { FakeLlm, makeSiteFetcher, noSleep, noopCtx, publicResolver } from './helpers/fakes';

const JD = `Senior Full-Stack Engineer at Acme Analytics

What we require:
- 5+ years of React experience
- Mentoring junior engineers
- PostgreSQL schema design experience

Nice to have:
- Kubernetes in production`;

function questionRaw(ids: string[], prompt: string, difficulty = 2) {
  return { requirement_ids: ids, prompt, answer_outline: 'guidance points', difficulty };
}

/** Extraction with two must-have technicals (r1, r3), one must behavioural (r2), one nice (r4). */
const EXTRACTION = () => ({
  title: 'Senior Full-Stack Engineer',
  seniority: 'senior',
  location: 'Remote',
  responsibilities: ['Build services', 'Mentor engineers'],
  requirements: [
    { text: '5+ years of React experience', kind: 'technical', priority: 'must' },
    { text: 'Mentoring junior engineers', kind: 'behavioural', priority: 'must' },
    { text: 'PostgreSQL schema design experience', kind: 'technical', priority: 'must' },
    { text: 'Kubernetes in production', kind: 'technical', priority: 'nice' },
  ],
});

const SITE: Record<string, string> = {
  '/acme/index.html': `<html><head><title>Acme Analytics — Home</title>
    <meta property="og:site_name" content="Acme Analytics"></head><body>
    <a href="about.html">About us</a> <a href="blog.html">Engineering blog</a></body></html>`,
  '/acme/about.html': `<html><head><title>About</title></head><body>
    <a href="handbook.html">Handbook</a></body></html>`,
  '/acme/handbook.html': `<html><head><title>Handbook</title></head><body>
    <a href="careers.html">careers</a></body></html>`,
  '/acme/careers.html': `<html><head><title>Careers</title></head><body>
    Our hiring process: take-home exercise then a system design round.</body></html>`,
  '/acme/blog.html': `<html><head><title>Blog</title></head><body><p>Posts.</p></body></html>`,
};

function depsFor(llm: FakeLlm, extra: Partial<PipelineDeps> = {}): PipelineDeps {
  return {
    llm,
    fetcher: makeSiteFetcher(SITE),
    resolveHost: publicResolver,
    allowPrivate: false,
    sleep: noSleep,
    ...extra,
  };
}

describe('pipeline run (offline: fake LLM + fake fetcher)', () => {
  it('closes a missed must-have with a genuine second pass and ships a valid kit', async () => {
    const llm = new FakeLlm({
      'role extraction': EXTRACTION,
      'company brief': () => ({ summary: 'Acme builds analytics tooling.', what_they_do: 'A product telemetry platform.' }),
      // first technical batch misses must-have r3 (PostgreSQL) on purpose
      'questions:technical': () => ({
        questions: [questionRaw(['r1'], 'Walk through a React reconciliation problem you debugged.')],
      }),
      'questions:behavioural': () => ({
        questions: [questionRaw(['r2'], 'Tell me about mentoring a struggling junior engineer.')],
      }),
      'questions:system-design': () => ({
        questions: [questionRaw(['r1'], 'Design the front-end architecture for a live funnel dashboard.')],
      }),
      'questions:company-fit': () => ({
        questions: [questionRaw(['r1'], 'How would you prepare for our take-home exercise?')],
      }),
      // the gap pass targets ONLY the uncovered r3 and closes it
      'questions:gap-fill': () => ({
        questions: [questionRaw(['r3'], 'How do you approach PostgreSQL schema design for high-write tables?')],
      }),
      flashcards: () => ({
        flashcards: [
          { front: 'What does React reconciliation diff?', back: 'The element tree, minimally.', requirement_ids: ['r1'] },
          { front: 'Name two mentoring anti-patterns.', back: 'Fixing it for them; vague feedback.', requirement_ids: ['r2'] },
          { front: 'When is a composite index worth it?', back: 'Multi-column equality + range patterns.', requirement_ids: ['r3'] },
        ],
      }),
    });
    const generator = createKitGenerator(depsFor(llm));
    const log: string[] = [];
    const { kit } = await generator.run(
      { jd: JD, companyUrl: 'http://fixture.test/acme/', days: 3 },
      noopCtx(log),
    );

    // the coverage loop is genuine: initial pass missed r3, gap pass closed it
    expect(kit.coverage.passes).toBe(2);
    expect(kit.coverage.uncovered_requirement_ids).toEqual([]);
    expect(llm.called('questions:gap-fill')).toBe(1);
    const gapQuestion = kit.questions.find((q) => q.requirement_ids.includes('r3'));
    expect(gapQuestion).toBeDefined();
    expect(gapQuestion?.category).toBe('technical'); // assigned by code from the requirement kind

    // one SEPARATE call per category, in sequence
    expect(llm.called('questions:technical')).toBe(1);
    expect(llm.called('questions:behavioural')).toBe(1);
    expect(llm.called('questions:system-design')).toBe(1);
    expect(llm.called('questions:company-fit')).toBe(1);
    expect(llm.called('role extraction')).toBe(1);
    expect(llm.called('company brief')).toBe(1);

    // company-fit used the hiring evidence actually crawled
    const companyFitPrompt = llm.calls.find((c) => c.schemaName === 'questions:company-fit')?.prompt ?? '';
    expect(companyFitPrompt).toContain('take-home');

    // ids/state assigned by code
    const ids = kit.questions.map((q) => q.id);
    expect(ids).toEqual([...new Set(ids)]); // unique
    expect(ids[0]).toBe('q1');
    for (const q of kit.questions) {
      expect(q.origin).toBe('generated');
      expect(q.item_state).toBe('pristine');
      expect(q.pinned).toBe(false);
    }
    expect(kit.flashcards.map((f) => f.id)).toEqual(['f1', 'f2', 'f3']);

    // the buried careers page was discovered and used
    expect(kit.source.pages_used).toContain('http://fixture.test/acme/careers.html');
    expect(kit.source.company).toBe('Acme Analytics');
    expect(kit.source.jd_chars).toBe(JD.length);
    expect(kit.company_brief.sources.length).toBeGreaterThan(0);

    // schedule is deterministic and exact
    expect(kit.schedule.days_available).toBe(3);
    expect(kit.schedule.days).toHaveLength(3);
    const scheduled = kit.schedule.days.flatMap((d) => d.question_ids);
    expect(new Set(scheduled)).toEqual(new Set(kit.questions.map((q) => q.id)));
    for (const day of kit.schedule.days) {
      expect(Number.isInteger(day.minutes)).toBe(true);
      expect(day.focus.length).toBeGreaterThan(0);
    }

    // full Appendix A validation passes
    expect(() => kitSchema.parse(kit)).not.toThrow();

    // progress events were emitted for every stage
    for (const stage of ['extract', 'crawl', 'discussion', 'brief', 'questions', 'coverage', 'flashcards', 'schedule', 'validate']) {
      expect(log.some((l) => l.startsWith(`${stage}:`))).toBe(true);
    }
  });

  it('fails with COVERAGE_INCOMPLETE when gap passes cannot close a must-have', async () => {
    const llm = new FakeLlm({
      'role extraction': EXTRACTION,
      'company brief': () => ({ summary: 's', what_they_do: 'd' }),
      'questions:technical': () => ({ questions: [questionRaw(['r1'], 'A React reconciliation question with enough length.')] }),
      'questions:behavioural': () => ({ questions: [questionRaw(['r2'], 'A mentoring question with enough length.')] }),
      'questions:system-design': () => ({ questions: [questionRaw(['r1'], 'A design question with enough length.')] }),
      'questions:company-fit': () => ({ questions: [questionRaw(['r1'], 'A company fit question with enough length.')] }),
      // the gap pass stubbornly refuses to cover r3
      'questions:gap-fill': () => ({ questions: [questionRaw(['r1'], 'An off-target question that ignores r3 entirely.')] }),
      flashcards: () => ({ flashcards: [] }),
    });
    const generator = createKitGenerator(depsFor(llm));
    await expect(
      generator.run({ jd: JD, companyUrl: 'http://fixture.test/acme/', days: 2 }, noopCtx()),
    ).rejects.toMatchObject({ code: 'COVERAGE_INCOMPLETE', message: expect.stringContaining('r3') });
    expect(llm.called('questions:gap-fill')).toBe(2); // max 3 passes total (initial + 2 gap)
  });

  it('skips system-design when there are no technical requirements', async () => {
    const llm = new FakeLlm({
      'role extraction': () => ({
        title: 'Engineering Manager',
        seniority: 'senior',
        location: '',
        responsibilities: [],
        requirements: [
          { text: 'Mentoring junior engineers', kind: 'behavioural', priority: 'must' },
          { text: 'Cross-team communication', kind: 'behavioural', priority: 'must' },
        ],
      }),
      'company brief': () => ({ summary: 's', what_they_do: 'd' }),
      'questions:technical': () => ({ questions: [] }),
      'questions:behavioural': () => ({
        questions: [
          questionRaw(['r1'], 'Tell me about growing an engineer to the next level.'),
          questionRaw(['r2'], 'Describe a cross-team disagreement you resolved.'),
        ],
      }),
      'questions:company-fit': () => ({ questions: [questionRaw(['r1'], 'Why manage at Acme specifically?')] }),
      flashcards: () => ({ flashcards: [{ front: 'Front', back: 'Back', requirement_ids: ['r1'] }] }),
    });
    const generator = createKitGenerator(depsFor(llm));
    const { kit } = await generator.run(
      { jd: JD, companyUrl: 'http://fixture.test/acme/', days: 4 },
      noopCtx(),
    );
    expect(llm.called('questions:system-design')).toBe(0);
    expect(kit.coverage.passes).toBe(1);
    expect(kit.coverage.uncovered_requirement_ids).toEqual([]);
    // more days than questions: review days fill the gap, still exactly 4 days
    expect(kit.schedule.days).toHaveLength(4);
    expect(() => kitSchema.parse(kit)).not.toThrow();
  });

  it('an unreachable site is an ok kit with honest warnings, not a failure', async () => {
    const llm = new FakeLlm({
      'role extraction': EXTRACTION,
      'company brief': () => ({ summary: 's', what_they_do: 'd' }), // not called: no research at all
      'questions:technical': () => ({
        questions: [
          questionRaw(['r1'], 'A React question with enough length to be kept.'),
          questionRaw(['r3'], 'A PostgreSQL question with enough length to be kept.'),
        ],
      }),
      'questions:behavioural': () => ({ questions: [questionRaw(['r2'], 'A mentoring question with enough length.')] }),
      'questions:system-design': () => ({ questions: [questionRaw(['r1'], 'A design question with enough length.')] }),
      'questions:company-fit': () => ({ questions: [questionRaw(['r1'], 'A fit question with enough length.')] }),
      flashcards: () => ({ flashcards: [{ front: 'F', back: 'B', requirement_ids: ['r1'] }] }),
    });
    const failingFetcher = async (): Promise<Response> => {
      throw new TypeError('fetch failed: connection refused');
    };
    const generator = createKitGenerator({
      llm,
      fetcher: failingFetcher,
      resolveHost: publicResolver,
      allowPrivate: false,
      sleep: noSleep,
    });
    const { kit, warnings } = await generator.run(
      { jd: JD, companyUrl: 'http://fixture.test/acme/', days: 3 },
      noopCtx(),
    );
    expect(warnings.some((w) => w.code === 'SITE_UNREACHABLE')).toBe(true);
    expect(kit.source.pages_used).toEqual([]);
    expect(llm.called('company brief')).toBe(0); // honest deterministic brief, no wasted call
    expect(kit.company_brief.summary.toLowerCase()).toContain('no usable research');
    expect(warnings.some((w) => w.code === 'NO_COMPANY_RESEARCH')).toBe(true);
    expect(() => kitSchema.parse(kit)).not.toThrow();
  });

  it('an empty JD fails the case with EXTRACT_FAILED', async () => {
    const generator = createKitGenerator(depsFor(new FakeLlm({})));
    await expect(
      generator.run({ jd: '   ', companyUrl: 'http://fixture.test/acme/', days: 3 }, noopCtx()),
    ).rejects.toMatchObject({ code: 'EXTRACT_FAILED' });
  });

  it('a two-line stub JD produces an honest thin kit', async () => {
    const llm = new FakeLlm({
      'role extraction': () => ({
        title: 'Developer',
        seniority: 'mid',
        location: '',
        responsibilities: [],
        requirements: [],
      }),
      flashcards: () => ({ flashcards: [] }),
    });
    const generator = createKitGenerator(depsFor(llm));
    const { kit } = await generator.run(
      { jd: 'We are hiring a developer.\nApply now.', companyUrl: 'http://fixture.test/acme/', days: 2 },
      noopCtx(),
    );
    expect(kit.role.requirements).toEqual([]);
    expect(kit.questions).toEqual([]);
    expect(kit.coverage.passes).toBe(1);
    expect(kit.warnings.some((w) => w.code === 'THIN_JD')).toBe(true);
    expect(kit.schedule.days).toHaveLength(2); // reading days, still exactly 2
    expect(() => kitSchema.parse(kit)).not.toThrow();
  });

  it('checkpoints let a resumed run skip completed stages', async () => {
    const llm = new FakeLlm({
      'role extraction': EXTRACTION,
      'company brief': () => ({ summary: 's', what_they_do: 'd' }),
      'questions:technical': () => ({
        questions: [
          questionRaw(['r1'], 'A React question with enough length.'),
          questionRaw(['r3'], 'A PostgreSQL question with enough length.'),
        ],
      }),
      'questions:behavioural': () => ({ questions: [questionRaw(['r2'], 'A mentoring question with enough length.')] }),
      'questions:system-design': () => ({ questions: [questionRaw(['r1'], 'A design question with enough length.')] }),
      'questions:company-fit': () => ({ questions: [questionRaw(['r1'], 'A fit question with enough length.')] }),
      flashcards: () => ({ flashcards: [{ front: 'F', back: 'B', requirement_ids: ['r1'] }] }),
    });
    const generator = createKitGenerator(depsFor(llm));

    // First run records checkpoints.
    const saved = new Map<string, unknown>();
    const recordingCtx = {
      onProgress: () => undefined,
      saveCheckpoint: async (stage: string, data: unknown) => {
        saved.set(stage, data);
      },
      loadCheckpoint: async () => null,
    };
    await generator.run({ jd: JD, companyUrl: 'http://fixture.test/acme/', days: 2 }, recordingCtx);
    expect(saved.has('extract')).toBe(true);
    expect(saved.has('questions')).toBe(true);
    const callsAfterFirstRun = llm.calls.length;

    // Second run resumes: every stage's data is served from checkpoints, so no new LLM calls.
    const resumingCtx = {
      onProgress: () => undefined,
      saveCheckpoint: async () => undefined,
      loadCheckpoint: async (stage: string) => saved.get(stage) ?? null,
    };
    const { kit } = await generator.run({ jd: JD, companyUrl: 'http://fixture.test/acme/', days: 2 }, resumingCtx);
    expect(llm.calls.length).toBe(callsAfterFirstRun);
    expect(() => kitSchema.parse(kit)).not.toThrow();
  });

  it('regenerating a question category preserves manual/edited/pinned items', async () => {
    const llm = new FakeLlm({
      'role extraction': EXTRACTION,
      'company brief': () => ({ summary: 's', what_they_do: 'd' }),
      'questions:technical': () => ({
        questions: [
          questionRaw(['r1'], 'A React question with enough length.'),
          questionRaw(['r3'], 'A PostgreSQL question with enough length.'),
        ],
      }),
      'questions:behavioural': () => ({ questions: [questionRaw(['r2'], 'A mentoring question with enough length.')] }),
      'questions:system-design': () => ({ questions: [questionRaw(['r1'], 'A design question with enough length.')] }),
      'questions:company-fit': () => ({ questions: [questionRaw(['r1'], 'A fit question with enough length.')] }),
      flashcards: () => ({ flashcards: [{ front: 'F', back: 'B', requirement_ids: ['r1'] }] }),
    });
    const generator = createKitGenerator(depsFor(llm));
    const { kit } = await generator.run({ jd: JD, companyUrl: 'http://fixture.test/acme/', days: 2 }, noopCtx());

    // user edits: pin one generated technical question, edit another, add a manual one
    const pinned = kit.questions.find((q) => q.category === 'technical');
    expect(pinned).toBeDefined();
    pinned!.pinned = true;
    const edited = kit.questions.find((q) => q.category === 'technical' && !q.pinned);
    expect(edited).toBeDefined();
    edited!.item_state = 'edited';
    kit.questions.push({
      id: 'q99',
      requirement_ids: ['r1'],
      category: 'technical',
      prompt: 'My own hand-written question.',
      answer_outline: 'mine',
      difficulty: 1,
      origin: 'manual',
      item_state: 'pristine',
      pinned: false,
    });

    const regenerated = await generator.regenerate(kit, 'technical', {}, noopCtx());
    const techQuestions = regenerated.kit.questions.filter((q) => q.category === 'technical');
    expect(techQuestions.some((q) => q.pinned)).toBe(true); // pinned survived
    expect(techQuestions.some((q) => q.item_state === 'edited')).toBe(true); // edited survived
    expect(techQuestions.some((q) => q.id === 'q99' && q.origin === 'manual')).toBe(true); // manual survived
    // fresh pristine generated questions replaced the ones that were neither edited nor pinned
    const protectedIds = new Set(['q1', 'q2', 'q99']);
    const fresh = techQuestions.filter((q) => !protectedIds.has(q.id));
    expect(fresh.length).toBeGreaterThan(0);
    expect(fresh.every((q) => q.origin === 'generated' && q.item_state === 'pristine' && !q.pinned)).toBe(true);
    // other categories untouched
    expect(regenerated.kit.questions.some((q) => q.category === 'behavioural' && q.id === 'q3')).toBe(true);
    expect(
      regenerated.kit.schedule.days.every((d) =>
        d.question_ids.every((id) => regenerated.kit.questions.some((q) => q.id === id)),
      ),
    ).toBe(true);
    expect(() => kitSchema.parse(regenerated.kit)).not.toThrow();
  });

  it('regenerating the schedule recomputes exactly the requested days', async () => {
    const generator = createKitGenerator(depsFor(new FakeLlm({
      'role extraction': EXTRACTION,
      'company brief': () => ({ summary: 's', what_they_do: 'd' }),
      'questions:technical': () => ({
        questions: [questionRaw(['r1'], 'A React question with enough length.'), questionRaw(['r3'], 'A PostgreSQL question with enough length.')],
      }),
      'questions:behavioural': () => ({ questions: [questionRaw(['r2'], 'A mentoring question with enough length.')] }),
      'questions:system-design': () => ({ questions: [questionRaw(['r1'], 'A design question with enough length.')] }),
      'questions:company-fit': () => ({ questions: [questionRaw(['r1'], 'A fit question with enough length.')] }),
      flashcards: () => ({ flashcards: [{ front: 'F', back: 'B', requirement_ids: ['r1'] }] }),
    })));
    const { kit } = await generator.run({ jd: JD, companyUrl: 'http://fixture.test/acme/', days: 5 }, noopCtx());
    const result = await generator.regenerate(kit, 'schedule', { days: 1 }, noopCtx());
    expect(result.kit.schedule.days_available).toBe(1);
    expect(result.kit.schedule.days).toHaveLength(1);
    expect(result.kit.schedule.days[0].question_ids.sort()).toEqual(kit.questions.map((q) => q.id).sort());
  });
});

describe('pipeline input guard', () => {
  it('rejects impossible day counts with a structured error', async () => {
    const generator = createKitGenerator(depsFor(new FakeLlm({})));
    await expect(
      generator.run({ jd: JD, companyUrl: 'http://fixture.test/acme/', days: 0 }, noopCtx()),
    ).rejects.toBeInstanceOf(PipelineError);
    await expect(
      generator.run({ jd: JD, companyUrl: 'http://fixture.test/acme/', days: 61 }, noopCtx()),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
});
