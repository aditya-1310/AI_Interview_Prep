import { describe, expect, it } from 'vitest';
import { PipelineError } from '../src/core/ports';
import { extractRole } from '../src/services/extract';
import { FakeLlm } from './helpers/fakes';

const UNTRUSTED_MARKER = 'UNTRUSTED CONTENT';

const JD = `Senior Full-Stack Engineer

We require:
- 5+ years of React experience
- Solid PostgreSQL skills
- Mentoring junior engineers

Nice to have:
- Kubernetes`;

describe('requirement extraction (offline fake LLM)', () => {
  it('assigns stable ids r1..rN in code and computes jd_chars from the raw JD', async () => {
    const llm = new FakeLlm({
      'role extraction': () => ({
        title: 'Senior Full-Stack Engineer',
        seniority: 'senior',
        location: 'Remote',
        responsibilities: ['Build services', 'Mentor engineers'],
        requirements: [
          { text: '5+ years of React experience', kind: 'technical', priority: 'must' },
          { text: 'Solid PostgreSQL skills', kind: 'technical', priority: 'must' },
          { text: 'Mentoring junior engineers', kind: 'behavioural', priority: 'must' },
          { text: 'Kubernetes', kind: 'technical', priority: 'nice' },
        ],
      }),
    });
    const role = await extractRole(llm, JD);
    expect(role.requirements.map((r) => r.id)).toEqual(['r1', 'r2', 'r3', 'r4']);
    expect(role.jdChars).toBe(JD.length);
    expect(role.title).toBe('Senior Full-Stack Engineer');
    expect(role.responsibilities).toHaveLength(2);
  });

  it('drops garbage entries and dedupes instead of trusting the model', async () => {
    const llm = new FakeLlm({
      'role extraction': () => ({
        title: 'Dev',
        seniority: '',
        location: '',
        responsibilities: ['', '   ', 'Write code'],
        requirements: [
          { text: '5+ years of React experience', kind: 'technical', priority: 'must' },
          { text: '  ', kind: 'technical', priority: 'must' }, // empty -> dropped
          { text: 'Wears many hats', kind: 'vibes', priority: 'must' }, // bad kind -> dropped
          { text: 'Telepathy', kind: 'technical', priority: 'whenever' }, // bad priority -> dropped
          { text: '5+ years of React experience', kind: 'technical', priority: 'must' }, // dupe -> dropped
          { text: 'Writes tests', kind: 'technical', priority: 'must' },
        ],
      }),
    });
    const role = await extractRole(llm, JD);
    expect(role.requirements).toEqual([
      { id: 'r1', text: '5+ years of React experience', kind: 'technical', priority: 'must' },
      { id: 'r2', text: 'Writes tests', kind: 'technical', priority: 'must' },
    ]);
    expect(role.responsibilities).toEqual(['Write code']);
  });

  it('normalises common model spellings of kind and priority', async () => {
    const llm = new FakeLlm({
      'role extraction': () => ({
        title: 'Engineer',
        seniority: '',
        location: 'Berlin',
        responsibilities: [],
        requirements: [
          { text: 'Mentoring junior engineers', kind: 'behavioral', priority: 'required' },
          { text: 'Kubernetes', kind: 'tech', priority: 'bonus' },
        ],
      }),
    });
    const role = await extractRole(llm, JD);
    expect(role.requirements).toEqual([
      { id: 'r1', text: 'Mentoring junior engineers', kind: 'behavioural', priority: 'must' },
      { id: 'r2', text: 'Kubernetes', kind: 'technical', priority: 'nice' },
    ]);
  });

  it('falls back to a code-side seniority guess when the model says nothing', async () => {
    const llm = new FakeLlm({
      'role extraction': () => ({
        title: 'Senior Engineer',
        seniority: '',
        location: '',
        responsibilities: [],
        requirements: [{ text: 'Writes Go', kind: 'technical', priority: 'must' }],
      }),
    });
    const role = await extractRole(llm, JD);
    expect(role.seniority).toBe('senior');
  });

  it('wraps the JD in an untrusted DATA block with the injection rule', async () => {
    const llm = new FakeLlm({
      'role extraction': () => ({ title: '', seniority: '', location: '', responsibilities: [], requirements: [] }),
    });
    await extractRole(llm, JD);
    const prompt = llm.calls[0].prompt;
    expect(prompt).toContain('<data label="job description">');
    expect(prompt).toContain(UNTRUSTED_MARKER);
    expect(prompt).toContain('5+ years of React experience');
  });

  it('throws EXTRACT_FAILED for an empty or whitespace-only JD', async () => {
    const llm = new FakeLlm({});
    await expect(extractRole(llm, '')).rejects.toMatchObject({ code: 'EXTRACT_FAILED' });
    await expect(extractRole(llm, '   \n\t  ')).rejects.toMatchObject({
      code: 'EXTRACT_FAILED',
      message: expect.stringContaining('empty'),
    });
    // A two-line stub is NOT empty: it goes through and honestly yields little
    const stub = new FakeLlm({
      'role extraction': () => ({
        title: 'Developer',
        seniority: 'mid',
        location: '',
        responsibilities: [],
        requirements: [],
      }),
    });
    const role = await extractRole(stub, 'We are hiring a developer.\nApply now.');
    expect(role.requirements).toEqual([]);
    expect(role.jdChars).toBeGreaterThan(0);
  });
});
