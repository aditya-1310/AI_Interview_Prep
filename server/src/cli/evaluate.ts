// Batch entry point (assignment §9 / Appendix B):
//   npm run evaluate -- --input <cases.json> --output <kits.json>
// Reads a JSON array of {id, jd, company_url, days}, runs the SAME pipeline
// the app uses (services/pipeline.ts via DI), max 2 cases concurrent, per-case
// isolation - a failure is recorded, never aborts the run. Writes the exact
// Appendix B envelope and exits 0 even when individual cases failed.

import { existsSync, realpathSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import dotenv from 'dotenv';
import type { KitGenerator } from '../core/ports';
import { PipelineError } from '../core/ports';
import { batchCaseInputSchema, batchOutputSchema } from '../core/schemas';
import type { BatchCaseInput, BatchKitResult, BatchOutput } from '../core/types';
import { createKitGenerator } from '../services/pipeline';

export interface CliArgs {
  input?: string;
  output?: string;
}

export function parseCliArgs(argv: string[]): CliArgs {
  const args: CliArgs = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--input') args.input = argv[++i];
    else if (a === '--output') args.output = argv[++i];
    else if (a.startsWith('--input=')) args.input = a.slice('--input='.length);
    else if (a.startsWith('--output=')) args.output = a.slice('--output='.length);
  }
  return args;
}

/**
 * Load the repo-root .env. The command runs from the repo root via npm, but
 * also resolve relative to this module so it works from server/ too. dotenv
 * never overrides variables that are already set.
 */
export function loadEnv(): void {
  const moduleDir = dirname(fileURLToPath(import.meta.url)); // server/src/cli
  const repoRoot = resolve(moduleDir, '..', '..', '..');
  for (const candidate of [resolve(process.cwd(), '.env'), resolve(repoRoot, '.env')]) {
    if (existsSync(candidate)) dotenv.config({ path: candidate, quiet: true });
  }
}

/** Lenient per-case validation: invalid entries become failed results, not crashes. */
export function splitCases(raw: unknown[]): { cases: BatchCaseInput[]; failures: BatchKitResult[] } {
  const cases: BatchCaseInput[] = [];
  const failures: BatchKitResult[] = [];
  raw.forEach((entry, index) => {
    const parsed = batchCaseInputSchema.safeParse(entry);
    if (parsed.success) {
      cases.push(parsed.data);
      return;
    }
    const id =
      entry && typeof entry === 'object' && typeof (entry as { id?: unknown }).id === 'string' && (entry as { id?: string }).id
        ? (entry as { id: string }).id
        : `case-${index + 1}`;
    failures.push({
      id,
      status: 'failed',
      kit: null,
      error: {
        code: 'INVALID_CASE',
        message: parsed.error.issues.map((i) => `${i.path.join('.') || 'case'}: ${i.message}`).join('; '),
      },
    });
  });
  return { cases, failures };
}

export interface RunCasesOptions {
  concurrency?: number;
  log?: (line: string) => void;
}

/** Pure runner (injectable generator) - also what the offline tests exercise. */
export async function runCases(
  generator: KitGenerator,
  cases: BatchCaseInput[],
  options: RunCasesOptions = {},
): Promise<BatchKitResult[]> {
  const concurrency = Math.max(1, Math.min(options.concurrency ?? 2, cases.length || 1));
  const log = options.log ?? ((line: string) => console.log(line));
  const results: BatchKitResult[] = new Array(cases.length);
  let cursor = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const index = cursor++;
      if (index >= cases.length) return;
      const c = cases[index];
      const startedAt = Date.now();
      try {
        const { kit } = await generator.run(
          { jd: c.jd, companyUrl: c.company_url, days: c.days },
          {
            onProgress: (step, message) => log(`[${c.id}] ${step}: ${message}`),
            saveCheckpoint: async () => undefined,
            loadCheckpoint: async () => null,
          },
        );
        results[index] = { id: c.id, status: 'ok', kit, error: null };
      } catch (err) {
        const code = err instanceof PipelineError ? err.code : 'UNEXPECTED';
        const message = err instanceof Error ? err.message : String(err);
        log(`[${c.id}] failed: ${code} - ${message}`);
        results[index] = { id: c.id, status: 'failed', kit: null, error: { code, message } };
      }
      const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
      log(`[${c.id}] ${results[index].status} in ${seconds}s`);
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return results;
}

export function buildEnvelope(results: BatchKitResult[]): BatchOutput {
  const envelope: BatchOutput = {
    version: '1.0',
    generated_at: new Date().toISOString(),
    kits: results,
  };
  // Validate against the Appendix B contract (field names/enums exact); the
  // schema does not transform anything, so the typed object is returned as-is.
  batchOutputSchema.parse(envelope);
  return envelope;
}

const USAGE =
  'usage: npm run evaluate -- --input <cases.json> --output <kits.json>\n' +
  '  --input   JSON array of {id, jd, company_url, days} cases\n' +
  '  --output  path to write the Appendix B result envelope';

async function main(): Promise<number> {
  const args = parseCliArgs(process.argv.slice(2));
  if (!args.input || !args.output) {
    console.error(USAGE);
    return 1;
  }

  loadEnv();

  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(args.input, 'utf-8'));
  } catch (err) {
    console.error(`evaluate: cannot read input file "${args.input}": ${err instanceof Error ? err.message : String(err)}`);
    console.error(USAGE);
    return 1;
  }
  if (!Array.isArray(raw)) {
    console.error('evaluate: input file must contain a JSON array of cases');
    return 1;
  }

  const { cases, failures } = splitCases(raw);
  for (const failure of failures) {
    console.error(`[${failure.id}] failed: ${failure.error?.code} - ${failure.error?.message}`);
  }

  const generator = createKitGenerator();
  const results = await runCases(generator, cases);

  let envelope: BatchOutput;
  try {
    envelope = buildEnvelope([...results, ...failures]);
  } catch (err) {
    console.error(`evaluate: output envelope failed validation: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }

  await writeFile(args.output, `${JSON.stringify(envelope, null, 2)}\n`, 'utf-8');
  const okCount = envelope.kits.filter((k) => k.status === 'ok').length;
  console.log(`evaluate: ${okCount}/${envelope.kits.length} case(s) ok -> ${args.output}`);
  return 0; // per-case failures are recorded in the envelope, not exit codes
}

const isMain = (() => {
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
})();

if (isMain) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      console.error(`evaluate: unexpected error: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    });
}
