import { describe, expect, it } from 'vitest';
import type { KitGenerator } from '../src/core/ports';
import { PipelineError } from '../src/core/ports';
import { batchOutputSchema } from '../src/core/schemas';
import { buildEnvelope, parseCliArgs, runCases, splitCases } from '../src/cli/evaluate';
import { minimalKit } from './helpers/fakes';

function fakeGenerator(): KitGenerator {
  return {
    async run(input, ctx) {
      await ctx.onProgress('extract', 'Extracting role and requirements from the job description');
      if (input.jd.includes('EMPTY')) {
        throw new PipelineError('EXTRACT_FAILED', 'job description is empty');
      }
      if (input.jd.includes('BOOM')) {
        throw new Error('something completely unexpected');
      }
      const kit = minimalKit();
      kit.source.company_url = input.companyUrl;
      return { kit, warnings: [] };
    },
    async regenerate(kit) {
      return { kit, warnings: [] };
    },
  };
}

function CASE(id: string, jd = 'A decently long job description for testing.'): Record<string, unknown> {
  return {
    id,
    jd,
    company_url: 'https://example.com',
    days: 3,
  };
}

describe('cli argument parsing', () => {
  it('reads --input and --output in both separated and = forms', () => {
    expect(parseCliArgs(['--input', 'a.json', '--output', 'b.json'])).toEqual({ input: 'a.json', output: 'b.json' });
    expect(parseCliArgs(['--input=a.json', '--output=b.json'])).toEqual({ input: 'a.json', output: 'b.json' });
    expect(parseCliArgs([])).toEqual({});
    expect(parseCliArgs(['--input', 'a.json'])).toEqual({ input: 'a.json' });
  });
});

describe('case validation (lenient, per-case)', () => {
  it('keeps valid cases and records invalid ones as failed entries', () => {
    const { cases, failures } = splitCases([
      CASE('ok-1'),
      { id: 'no-jd', company_url: 'https://example.com', days: 3 }, // missing jd
      { id: 'bad-days', jd: 'x'.repeat(50), company_url: 'https://example.com', days: 0 }, // days out of range
      'not-even-an-object',
    ]);
    expect(cases.map((c) => c.id)).toEqual(['ok-1']);
    expect(failures).toHaveLength(3);
    for (const failure of failures) {
      expect(failure.status).toBe('failed');
      expect(failure.kit).toBeNull();
      expect(failure.error?.code).toBe('INVALID_CASE');
      expect(failure.error?.message.length).toBeGreaterThan(0);
    }
    expect(failures.map((f) => f.id)).toEqual(['no-jd', 'bad-days', 'case-4']); // fallback id for shapeless entries
  });

  it('strips unknown fields but keeps the documented ones', () => {
    const { cases } = splitCases([{ ...CASE('ok-extra'), extra: 'ignored' }]);
    expect(cases[0]).toEqual({ id: 'ok-extra', jd: 'A decently long job description for testing.', company_url: 'https://example.com', days: 3 });
  });
});

describe('runCases (pure runner with an injected generator)', () => {
  it('isolates failures: PipelineError and unexpected errors become failed entries, run continues', async () => {
    const lines: string[] = [];
    const results = await runCases(
      fakeGenerator(),
      [
        { id: 'case-ok', jd: 'normal jd text', company_url: 'https://example.com', days: 2 },
        { id: 'case-empty', jd: 'EMPTY jd', company_url: 'https://example.com', days: 2 },
        { id: 'case-boom', jd: 'BOOM jd', company_url: 'https://example.com', days: 2 },
      ],
      { concurrency: 2, log: (line) => lines.push(line) },
    );
    expect(results).toHaveLength(3);
    expect(results[0]).toMatchObject({ id: 'case-ok', status: 'ok' });
    expect(results[0].kit).not.toBeNull();
    expect(results[0].error).toBeNull();
    expect(results[1]).toMatchObject({
      id: 'case-empty',
      status: 'failed',
      kit: null,
      error: { code: 'EXTRACT_FAILED', message: 'job description is empty' },
    });
    expect(results[2]).toMatchObject({
      id: 'case-boom',
      status: 'failed',
      kit: null,
      error: { code: 'UNEXPECTED', message: 'something completely unexpected' },
    });
    // progress lines use the [id] stage format
    expect(lines.some((l) => l.startsWith('[case-ok] extract:'))).toBe(true);
    expect(lines.some((l) => l.includes('[case-ok] ok in'))).toBe(true);
    expect(lines.some((l) => l.startsWith('[case-empty] failed: EXTRACT_FAILED'))).toBe(true);
  });

  it('runs at most 2 cases concurrently', async () => {
    let inFlight = 0;
    let peak = 0;
    const slow: KitGenerator = {
      async run() {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 15));
        inFlight--;
        return { kit: minimalKit(), warnings: [] };
      },
      async regenerate(kit) {
        return { kit, warnings: [] };
      },
    };
    const many = Array.from({ length: 6 }, (_, i) => ({
      id: `c${i}`,
      jd: 'x'.repeat(40),
      company_url: 'https://example.com',
      days: 1,
    }));
    const results = await runCases(slow, many, { concurrency: 2, log: () => undefined });
    expect(results).toHaveLength(6);
    expect(results.every((r) => r.status === 'ok')).toBe(true);
    expect(peak).toBeLessThanOrEqual(2);
  });
});

describe('batch output envelope (Appendix B)', () => {
  it('produces the exact envelope shape and validates against the core schema', async () => {
    const results = await runCases(
      fakeGenerator(),
      [
        { id: 'case-ok', jd: 'normal jd text', company_url: 'https://example.com', days: 2 },
        { id: 'case-empty', jd: 'EMPTY jd', company_url: 'https://example.com', days: 2 },
      ],
      { log: () => undefined },
    );
    const envelope = buildEnvelope(results);
    expect(envelope.version).toBe('1.0');
    expect(envelope.generated_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    expect(envelope.kits).toHaveLength(2);
    expect(envelope.kits.map((k) => k.id)).toEqual(['case-ok', 'case-empty']);
    const parsed = batchOutputSchema.safeParse(envelope);
    expect(parsed.success).toBe(true);
    // exact per-entry fields, nothing more
    for (const entry of envelope.kits) {
      expect(Object.keys(entry).sort()).toEqual(['error', 'id', 'kit', 'status']);
    }
    expect(Object.keys(envelope).sort()).toEqual(['generated_at', 'kits', 'version']);
  });

  it('rejects envelopes whose kit does not match Appendix A', () => {
    expect(() =>
      buildEnvelope([{ id: 'x', status: 'ok', kit: { nonsense: true } as never, error: null }]),
    ).toThrow();
  });
});
