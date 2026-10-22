// In-process job execution. Routes create Job documents (status 'queued') and
// hand their id to startJob(); a tiny scheduler runs at most MAX_CONCURRENT_JOBS
// at a time so a 25-case batch cannot stampede the LLM provider.
//
// The generator itself arrives via dependency injection (setGenerator) so this
// module never imports services/** - routes and runner compile even while the
// pipeline is being built. index.ts wires the real implementation lazily.
import { ApiError } from '../middleware/errors';
import { Job, type JobHydrated } from '../models/Job';
import { Kit, type KitDoc, type KitHydrated } from '../models/Kit';
import { nextId } from '../core/ids';
import { repairScheduleAfterRegen, recomputeCoverageInPlace } from '../core/kitState';
import { recomputeSchedule } from '../core/schedule';
import { PipelineError, type KitGenerator, type PipelineResult, type RunContext, type Section } from '../core/ports';
import type { KitDocument, Warning } from '../core/types';

// ---------------------------------------------------------------------------
// Generator registry
// ---------------------------------------------------------------------------

let generatorRef: KitGenerator | undefined;

export function setGenerator(gen: KitGenerator): void {
  generatorRef = gen;
}

export function generatorWired(): boolean {
  return generatorRef !== undefined;
}

export function getGenerator(): KitGenerator {
  if (!generatorRef) {
    throw new ApiError(
      503,
      'GENERATOR_UNAVAILABLE',
      'The generation pipeline is not available yet; please try again shortly',
    );
  }
  return generatorRef;
}

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

const MAX_CONCURRENT_JOBS = 2;
const running = new Set<string>();
const waiting: string[] = [];

/** Queue a job for execution (fire-and-forget; never throws, never crashes). */
export function startJob(jobId: string): void {
  waiting.push(jobId);
  drain();
}

function drain(): void {
  while (running.size < MAX_CONCURRENT_JOBS && waiting.length > 0) {
    const id = waiting.shift();
    if (id === undefined || running.has(id)) continue;
    running.add(id);
    void executeJob(id)
      .catch((err) => console.error(`[jobs] job ${id} escaped execution:`, err))
      .finally(() => {
        running.delete(id);
        drain();
      });
  }
}

// ---------------------------------------------------------------------------
// Boot-time recovery
// ---------------------------------------------------------------------------

/**
 * Jobs live in the database but execute inside this process. On startup every
 * queued/running job is by definition an orphan (a restart killed its worker -
 * deploy, crash, or instance recycle). Mark them failed so the UI offers
 * Retry, which resumes from the checkpoints persisted before the restart.
 */
export async function recoverOrphanedJobs(): Promise<number> {
  const res = await Job.updateMany(
    { status: { $in: ['queued', 'running'] } },
    {
      $set: {
        status: 'failed',
        error: {
          code: 'INTERRUPTED',
          message: 'The server restarted while this job was running. Retry resumes it from the last completed step.',
        },
        finishedAt: new Date(),
      },
      $push: {
        progress: {
          step: 'interrupted',
          message: 'Server restarted; the job can be retried from its checkpoints',
          at: new Date().toISOString(),
        },
      },
    },
  );
  if (res.modifiedCount > 0) {
    console.warn(`[jobs] marked ${res.modifiedCount} orphaned job(s) failed after restart`);
  }
  return res.modifiedCount;
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

function plainKit(doc: { kit?: unknown }): KitDocument {
  return structuredClone((doc.kit ?? {}) as KitDocument);
}

function buildRunContext(job: JobHydrated): RunContext {
  // Persist via updateOne guards: if the job was deleted mid-run (kit
  // removed), the writes no-op instead of resurrecting the document.
  return {
    onProgress: async (step: string, message: string) => {
      job.progress.push({ step, message, at: new Date().toISOString() });
      try {
        await Job.updateOne({ _id: job._id }, { $set: { progress: job.progress } });
      } catch (err) {
        console.error(`[jobs] failed to persist progress for job ${job.id}:`, err);
      }
    },
    saveCheckpoint: async (stage: string, data: unknown) => {
      job.checkpoints[stage] = data;
      try {
        await Job.updateOne({ _id: job._id }, { $set: { checkpoints: job.checkpoints } });
      } catch (err) {
        console.error(`[jobs] failed to persist checkpoint ${stage} for job ${job.id}:`, err);
      }
    },
    loadCheckpoint: async (stage: string) => job.checkpoints[stage] ?? null,
  };
}

function errorCode(err: unknown): string {
  if (err instanceof ApiError) return err.code;
  if (err instanceof PipelineError) return err.code;
  return 'INTERNAL';
}

function errorMessage(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  return String(err);
}

async function markFailed(job: JobHydrated, err: unknown): Promise<void> {
  job.status = 'failed';
  job.error = { code: errorCode(err), message: errorMessage(err) };
  job.finishedAt = new Date();
  try {
    await Job.updateOne(
      { _id: job._id },
      { $set: { status: job.status, error: job.error, finishedAt: job.finishedAt } },
    );
  } catch (saveErr) {
    console.error(`[jobs] failed to persist failure of job ${job.id}:`, saveErr);
  }
  // 'failed' is reserved for "no producible kit at all"; keep any partial kit
  // data, only flip the status so the UI surfaces the failure and the job can
  // be retried from its checkpoints.
  try {
    await Kit.updateOne({ _id: job.kitId }, { $set: { status: 'failed' } });
  } catch (kitErr) {
    console.error(`[jobs] failed to mark kit ${job.kitId} as failed:`, kitErr);
  }
}

const WRITE_ATTEMPTS = 3;

function mergedWarnings(kit: KitDocument, warnings: Warning[] | undefined): Warning[] {
  const out = [...(kit.warnings ?? [])];
  const seen = new Set(out.map((w) => `${w.code}\u0000${w.message}`));
  for (const w of warnings ?? []) {
    const key = `${w.code}\u0000${w.message}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(w);
    }
  }
  return out;
}

/**
 * Merge a section regeneration (produced against `snapshot`) onto `fresh`,
 * the latest document state. The regeneration result is an INTENT - "replace
 * the pristine generated items of this category with these new ones" /
 * "rewrite the brief" - and that intent is applied against the live document,
 * so work the user did while the regeneration was running always wins:
 *  - edits to surviving questions keep the fresh version
 *  - questions added during the run are kept; regenerated items that collide
 *    with them get new ids instead of dropping either side
 *  - questions deleted during the run stay deleted (never resurrected)
 *  - a brief the user edited during the run is not overwritten
 */
export function mergeRegeneratedSection(
  fresh: KitDocument,
  snapshot: KitDocument,
  result: KitDocument,
  section: Section,
): KitDocument {
  fresh.warnings = mergedWarnings(fresh, result.warnings);
  if (section === 'brief') {
    // Only apply the rewritten brief if the user has not edited it since the
    // regeneration started; their words win.
    if (sameBrief(fresh.company_brief, snapshot.company_brief)) {
      fresh.company_brief = result.company_brief;
    }
    return fresh;
  }
  if (section === 'schedule') {
    fresh.schedule = result.schedule;
    return fresh;
  }
  const snapshotById = new Map(snapshot.questions.map((q) => [q.id, q] as const));
  const finalIds = new Set<string>();
  const merged: KitDocument['questions'] = [];
  // Keep everything currently in the kit EXCEPT the questions that are still
  // pristine, generated, unpinned items of the regenerated category - those
  // are the only things a category regeneration replaces. Reading this from
  // `fresh` (not the snapshot) is what protects concurrent edits: a question
  // the user edited or pinned mid-run is no longer pristine here.
  for (const q of fresh.questions) {
    const replacedByRegen =
      q.category === section && q.origin === 'generated' && q.item_state === 'pristine' && !q.pinned;
    if (replacedByRegen) continue;
    merged.push(q);
    finalIds.add(q.id);
  }
  // Append the regenerated items. Snapshot-derived entries are skipped (the
  // live versions above are fresher); brand-new items are added, re-iding any
  // that collide with a question the user added during the run.
  for (const q of result.questions) {
    if (snapshotById.has(q.id)) continue;
    if (finalIds.has(q.id)) {
      const id = nextId('q', [...finalIds]);
      merged.push({ ...q, id });
      finalIds.add(id);
    } else {
      merged.push(q);
      finalIds.add(q.id);
    }
  }
  fresh.questions = merged;
  const removedIds = [...snapshotById.keys()].filter((id) => !finalIds.has(id));
  const addedIds = [...finalIds].filter((id) => !snapshotById.has(id));
  return repairScheduleAfterRegen(fresh, removedIds, addedIds);
}

function sameBrief(a: KitDocument['company_brief'], b: KitDocument['company_brief']): boolean {
  return a.summary === b.summary && a.what_they_do === b.what_they_do;
}

/** Optimistic write helper: guarded on version, retried on losing races. */
async function guardedKitWrite(
  kitId: string,
  buildSet: (doc: KitHydrated) => Record<string, unknown>,
): Promise<KitHydrated> {
  for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt++) {
    const doc = await Kit.findById(kitId);
    if (!doc) throw new ApiError(404, 'KIT_NOT_FOUND', 'The kit for this job no longer exists');
    const updated = await Kit.findOneAndUpdate(
      { _id: doc._id, version: doc.version },
      { $set: { ...buildSet(doc), version: doc.version + 1 } },
      { new: true },
    );
    if (updated) return updated;
  }
  throw new ApiError(
    409,
    'WRITE_CONFLICT',
    'Could not apply the job result; the kit document kept changing. Retry the job.',
  );
}

async function applyGenerate(kitId: string, result: PipelineResult): Promise<void> {
  await guardedKitWrite(kitId, () => ({
    kit: { ...result.kit, warnings: mergedWarnings(result.kit, result.warnings) },
    status: 'ready',
  }));
}

async function applyRegenerate(
  kitId: string,
  snapshot: KitDocument,
  result: PipelineResult,
  section: Section,
): Promise<void> {
  await guardedKitWrite(kitId, (doc) => {
    const fresh = plainKit(doc);
    mergeRegeneratedSection(fresh, snapshot, result.kit, section);
    return { kit: fresh, status: 'ready' };
  });
}

async function executeJob(jobId: string): Promise<void> {
  let loaded: JobHydrated | null = null;
  try {
    const found = await Job.findById(jobId);
    if (!found || found.status !== 'queued') return;
    const job: JobHydrated = found;
    loaded = job;
    const gen = getGenerator();
    job.status = 'running';
    job.startedAt = new Date();
    await Job.updateOne(
      { _id: job._id },
      { $set: { status: job.status, startedAt: job.startedAt } },
    );

    const kitDoc = await Kit.findById(job.kitId);
    if (!kitDoc) throw new ApiError(404, 'KIT_NOT_FOUND', 'The kit for this job no longer exists');
    const ctx = buildRunContext(job);
    const section = job.section;
    const days = job.days;

    if (job.type === 'generate' || !section) {
      const result = await gen.run(
        {
          jd: kitDoc.input.jd,
          companyUrl: kitDoc.input.companyUrl,
          days: kitDoc.input.days,
        },
        ctx,
      );
      await applyGenerate(job.kitId, result);
    } else if (section === 'schedule') {
      // Deterministic, no LLM: rebuild in code straight onto the latest state.
      await guardedKitWrite(job.kitId, (doc) => {
        const fresh = plainKit(doc);
        if (days && days !== fresh.schedule.days_available) {
          fresh.schedule.days_available = days;
        }
        recomputeSchedule(fresh);
        recomputeCoverageInPlace(fresh);
        return { kit: fresh, status: 'ready' };
      });
    } else {
      const snapshot = plainKit(kitDoc);
      const result = await gen.regenerate(snapshot, section, { days }, ctx);
      await applyRegenerate(job.kitId, snapshot, result, section);
    }

    job.status = 'completed';
    job.finishedAt = new Date();
    job.progress.push({ step: 'done', message: 'Kit updated', at: new Date().toISOString() });
    await Job.updateOne(
      { _id: job._id },
      { $set: { status: job.status, finishedAt: job.finishedAt, progress: job.progress } },
    );
  } catch (err) {
    if (loaded) await markFailed(loaded, err);
    else console.error(`[jobs] job ${jobId} failed before it could load:`, err);
  }
}
