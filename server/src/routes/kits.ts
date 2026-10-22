// Kit REST surface per docs/03-api-contract.md. Every mutating endpoint
// accepts an optional baseVersion (optimistic concurrency): mismatch ->
// 409 VERSION_CONFLICT with the freshest document as currentKit; success
// bumps version and returns the updated full document.
import { Router } from 'express';
import { z } from 'zod';
import {
  batchCreateInputSchema,
  briefPatchSchema,
  confidenceSchema,
  createKitInputSchema,
  flashcardPatchSchema,
  newManualFlashcardSchema,
  newManualQuestionSchema,
  questionPatchSchema,
  regenerateInputSchema,
  reorderSchema,
  requirementKindSchema,
  requirementPrioritySchema,
  schedulePatchSchema,
} from '../core/schemas';
import type { Section } from '../core/ports';
import type { KitDocument, Question, Requirement } from '../core/types';
import {
  addManualFlashcard,
  addManualQuestion,
  applyFlashcardEdit,
  applyQuestionEdit,
  deleteFlashcard,
  deleteQuestion,
  deleteRequirement,
  reorderQuestions,
  recomputeCoverageInPlace,
  togglePin,
} from '../core/kitState';
import { nextId } from '../core/ids';
import { recomputeSchedule } from '../core/schedule';
import { inputHashFor, Kit, type KitDoc } from '../models/Kit';
import { Job, type JobDoc } from '../models/Job';
import { ApiError, asyncHandler } from '../middleware/errors';
import { requireAuth, requireUser } from '../middleware/auth';
import { getLoadedKit, loadKit } from '../middleware/loadKit';
import { getGenerator, startJob } from '../jobs/runner';

export const kitsRouter = Router();
kitsRouter.use(requireAuth);

// ---------------------------------------------------------------------------
// Request schemas (core schemas + the optional baseVersion field)
// ---------------------------------------------------------------------------

const createKitRequestSchema = createKitInputSchema.extend({
  force: z.boolean().optional(),
});

const rolePatchRequestSchema = z.object({
  title: z.string().min(1).optional(),
  seniority: z.string().min(1).optional(),
  responsibilities: z.array(z.string().min(1)).optional(),
  baseVersion: z.number().int().min(1).optional(),
});

const newRequirementRequestSchema = z.object({
  text: z.string().min(1),
  kind: requirementKindSchema,
  priority: requirementPrioritySchema,
  baseVersion: z.number().int().min(1).optional(),
});

const requirementPatchRequestSchema = z.object({
  text: z.string().min(1).optional(),
  kind: requirementKindSchema.optional(),
  priority: requirementPrioritySchema.optional(),
  baseVersion: z.number().int().min(1).optional(),
});

const newQuestionRequestSchema = newManualQuestionSchema.extend({
  baseVersion: z.number().int().min(1).optional(),
});

const newFlashcardRequestSchema = newManualFlashcardSchema.extend({
  baseVersion: z.number().int().min(1).optional(),
});

const confidenceRequestSchema = confidenceSchema.extend({
  baseVersion: z.number().int().min(1).optional(),
});

const pinRequestSchema = z.object({ baseVersion: z.number().int().min(1).optional() });

// ---------------------------------------------------------------------------
// Serialization (exported for tests)
// ---------------------------------------------------------------------------

export interface KitJson {
  id: string;
  userId: string;
  status: string;
  version: number;
  input: { jd: string; companyUrl: string; days: number; inputHash: string };
  kit: unknown;
  practice: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export function kitToJson(doc: KitDoc): KitJson {
  return {
    id: String(doc._id),
    userId: doc.userId,
    status: doc.status,
    version: doc.version,
    input: {
      jd: doc.input.jd,
      companyUrl: doc.input.companyUrl,
      days: doc.input.days,
      inputHash: doc.input.inputHash,
    },
    kit: (doc.kit ?? {}) as unknown,
    practice: (doc.practice ?? {}) as Record<string, unknown>,
    createdAt: doc.createdAt instanceof Date ? doc.createdAt.toISOString() : String(doc.createdAt),
    updatedAt: doc.updatedAt instanceof Date ? doc.updatedAt.toISOString() : String(doc.updatedAt),
  };
}

export interface KitListItemJson {
  id: string;
  company: string | null;
  role: string | null;
  status: string;
  days: number;
  createdAt: string;
}

export function kitToListJson(doc: KitDoc): KitListItemJson {
  const kit = doc.kit as KitDocument | undefined | null;
  return {
    id: String(doc._id),
    company: kit?.source?.company ?? null,
    role: kit?.source?.role ?? null,
    status: doc.status,
    days: doc.input.days,
    createdAt: doc.createdAt instanceof Date ? doc.createdAt.toISOString() : String(doc.createdAt),
  };
}

export interface JobJson {
  id: string;
  kitId: string;
  type: string;
  section: string | null;
  status: string;
  progress: { step: string; message: string; at: string }[];
  error?: { code: string; message: string };
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export function jobToJson(job: JobDoc): JobJson {
  const base: JobJson = {
    id: String(job._id),
    kitId: job.kitId,
    type: job.type,
    section: job.section ?? null,
    status: job.status,
    progress: job.progress ?? [],
    createdAt:
      job.createdAt instanceof Date ? job.createdAt.toISOString() : String(job.createdAt),
    startedAt: job.startedAt ? job.startedAt.toISOString() : null,
    finishedAt: job.finishedAt ? job.finishedAt.toISOString() : null,
  };
  if (job.error && job.error.code) base.error = job.error;
  return base;
}

/** Pure optimistic-concurrency predicate (exported for tests). */
export function baseVersionConflict(current: number, baseVersion: number | undefined): boolean {
  return baseVersion !== undefined && baseVersion !== current;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const RUNNING_STATUSES: string[] = ['queued', 'running'];
const MAX_RUNNING_JOBS_PER_USER = 3;
const WRITE_ATTEMPTS = 3;

async function versionConflictError(doc: KitDoc | null): Promise<ApiError> {
  return new ApiError(
    409,
    'VERSION_CONFLICT',
    'This kit changed while you were editing; re-apply your change to the latest version',
    undefined,
    doc ? { currentKit: kitToJson(doc) } : {},
  );
}

/**
 * Builder endpoints operate on a generated kit; a pending (or emptied) kit
 * has no structure to edit yet.
 */
function builderKitOf(doc: KitDoc): KitDocument {
  const kit = doc.kit as KitDocument | undefined | null;
  if (
    !kit ||
    !kit.role ||
    !Array.isArray(kit.questions) ||
    !Array.isArray(kit.flashcards) ||
    !kit.schedule ||
    !kit.coverage
  ) {
    throw new ApiError(
      409,
      'KIT_NOT_READY',
      'This kit has no generated content yet; wait for generation to finish or retry its job',
    );
  }
  return kit;
}

async function latestJobFor(kitId: string): Promise<JobDoc | null> {
  return Job.findOne({ kitId }).sort({ createdAt: -1, _id: -1 });
}

async function assertNoRunningJobForKit(kitId: string): Promise<void> {
  const runningJob = await Job.findOne({
    kitId,
    status: { $in: RUNNING_STATUSES },
  }).sort({ createdAt: -1 });
  if (runningJob) {
    throw new ApiError(
      429,
      'JOB_ALREADY_RUNNING',
      'A job is already running for this kit; wait for it to finish',
    );
  }
}

async function assertJobThrottle(userId: string): Promise<void> {
  const running = await Job.countDocuments({ userId, status: { $in: RUNNING_STATUSES } });
  if (running >= MAX_RUNNING_JOBS_PER_USER) {
    throw new ApiError(
      429,
      'TOO_MANY_RUNNING',
      `You already have ${running} running jobs; wait for one to finish before starting more`,
    );
  }
}

/**
 * Apply a builder mutation with optimistic concurrency: validate baseVersion,
 * run the (pure) mutator on a clone of the kit, then write guarded on the
 * current version so concurrent editors cannot clobber each other.
 * Every successful write bumps the version.
 */
async function applyKitMutation(
  res: Parameters<typeof getLoadedKit>[0],
  baseVersion: number | undefined,
  mutate: (kit: KitDocument) => void,
): Promise<KitDoc> {
  const doc = getLoadedKit(res);
  if (baseVersionConflict(doc.version, baseVersion)) {
    throw await versionConflictError(await Kit.findById(doc._id));
  }
  for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt++) {
    const base = attempt === 0 ? doc : await Kit.findById(doc._id);
    if (!base) throw new ApiError(404, 'NOT_FOUND', 'Kit not found');
    const kitCopy = structuredClone((base.kit ?? {}) as KitDocument);
    mutate(kitCopy);
    const updated = await Kit.findOneAndUpdate(
      { _id: base._id, version: base.version },
      { $set: { kit: kitCopy, version: base.version + 1 } },
      { new: true },
    );
    if (updated) return updated;
  }
  throw await versionConflictError(await Kit.findById(doc._id));
}

// ---------------------------------------------------------------------------
// Creation + dedupe
// ---------------------------------------------------------------------------

export interface CreateKitOutcome {
  kitId: string;
  jobId: string | null;
  duplicate: boolean;
}

interface CreateKitOptions {
  force?: boolean;
  /** Throttle check runs right before creating a NEW kit (after dedupe). */
  enforceThrottle?: boolean;
  /** Results already resolved during this request (batch dedupe within itself). */
  seen?: Map<string, CreateKitOutcome>;
}

export async function createOrReuseKit(
  userId: string,
  input: { jd: string; companyUrl: string; days: number },
  opts: CreateKitOptions = {},
): Promise<CreateKitOutcome> {
  const { force = false, enforceThrottle = true, seen } = opts;
  const hash = inputHashFor(input.jd, input.companyUrl, input.days);

  const prior = seen?.get(hash);
  if (prior && prior.jobId) return { ...prior, duplicate: true };

  // 1) A queued/running job with the same input returns that job.
  const runningJob = await Job.findOne({
    userId,
    inputHash: hash,
    status: { $in: RUNNING_STATUSES },
  }).sort({ createdAt: -1 });
  if (runningJob) {
    const outcome: CreateKitOutcome = {
      kitId: runningJob.kitId,
      jobId: String(runningJob._id),
      duplicate: true,
    };
    seen?.set(hash, outcome);
    return outcome;
  }

  // 2) A completed ready kit with the same input is returned unless force.
  if (!force) {
    const readyKit = await Kit.findOne({
      userId,
      'input.inputHash': hash,
      status: 'ready',
    }).sort({ createdAt: -1 });
    if (readyKit) {
      const outcome: CreateKitOutcome = {
        kitId: String(readyKit._id),
        jobId: null,
        duplicate: true,
      };
      seen?.set(hash, outcome);
      return outcome;
    }
  }

  // 3) Throttle, then create kit + generate job.
  if (enforceThrottle) await assertJobThrottle(userId);
  getGenerator(); // 503 GENERATOR_UNAVAILABLE when the pipeline is not wired
  const kit = await Kit.create({
    userId,
    status: 'pending',
    version: 1,
    input: { jd: input.jd, companyUrl: input.companyUrl, days: input.days, inputHash: hash },
    kit: {},
    practice: {},
  });
  const job = await Job.create({
    kitId: String(kit._id),
    userId,
    type: 'generate',
    status: 'queued',
    progress: [],
    checkpoints: {},
    inputHash: hash,
  });
  const outcome: CreateKitOutcome = {
    kitId: String(kit._id),
    jobId: String(job._id),
    duplicate: false,
  };
  seen?.set(hash, outcome);
  startJob(String(job._id));
  return outcome;
}

// ---------------------------------------------------------------------------
// Routes: create / list / read / delete
// ---------------------------------------------------------------------------

kitsRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const user = requireUser(req);
    const body = createKitRequestSchema.parse(req.body ?? {});
    const outcome = await createOrReuseKit(user.id, body, { force: body.force });
    res.status(outcome.duplicate ? 200 : 201).json(outcome);
  }),
);

kitsRouter.post(
  '/batch',
  asyncHandler(async (req, res) => {
    const user = requireUser(req);
    const body = batchCreateInputSchema.parse(req.body ?? {});
    // Reject the whole batch up front if the user already has too much in
    // flight; within the batch the in-process runner caps real concurrency.
    await assertJobThrottle(user.id);
    const seen = new Map<string, CreateKitOutcome>();
    const jobs: CreateKitOutcome[] = [];
    for (const c of body.cases) {
      jobs.push(await createOrReuseKit(user.id, c, { enforceThrottle: false, seen }));
    }
    res.status(201).json({ jobs });
  }),
);

kitsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const user = requireUser(req);
    const kits = await Kit.find({ userId: user.id }).sort({ createdAt: -1 });
    res.json(kits.map((k) => kitToListJson(k)));
  }),
);

kitsRouter.get(
  '/:id',
  loadKit,
  asyncHandler(async (_req, res) => {
    res.json(kitToJson(getLoadedKit(res)));
  }),
);

kitsRouter.delete(
  '/:id',
  loadKit,
  asyncHandler(async (_req, res) => {
    const doc = getLoadedKit(res);
    await Job.deleteMany({ kitId: String(doc._id) });
    await Kit.deleteOne({ _id: doc._id });
    res.status(204).send();
  }),
);

// ---------------------------------------------------------------------------
// Routes: jobs
// ---------------------------------------------------------------------------

kitsRouter.get(
  '/:id/job',
  loadKit,
  asyncHandler(async (_req, res) => {
    const doc = getLoadedKit(res);
    const job = await latestJobFor(String(doc._id));
    if (!job) throw new ApiError(404, 'NOT_FOUND', 'No job exists for this kit yet');
    res.json(jobToJson(job));
  }),
);

kitsRouter.post(
  '/:id/job/retry',
  loadKit,
  asyncHandler(async (req, res) => {
    const user = requireUser(req);
    const doc = getLoadedKit(res);
    const latest = await latestJobFor(String(doc._id));
    if (!latest) throw new ApiError(404, 'NOT_FOUND', 'No job exists for this kit yet');
    if (latest.status !== 'failed') {
      throw new ApiError(409, 'JOB_NOT_FAILED', 'Only a failed job can be retried');
    }
    await assertNoRunningJobForKit(String(doc._id));
    await assertJobThrottle(user.id);
    getGenerator();
    // Copy the old job's checkpoints so the pipeline resumes from the last
    // completed stage instead of redoing LLM calls.
    const job = await Job.create({
      kitId: String(doc._id),
      userId: user.id,
      type: latest.type,
      section: latest.section,
      days: latest.days,
      status: 'queued',
      progress: [],
      checkpoints: { ...(latest.checkpoints ?? {}) },
      inputHash: latest.inputHash,
    });
    startJob(String(job._id));
    res.status(202).json({ jobId: String(job._id) });
  }),
);

// ---------------------------------------------------------------------------
// Routes: regenerate
// ---------------------------------------------------------------------------

kitsRouter.post(
  '/:id/regenerate',
  loadKit,
  asyncHandler(async (req, res) => {
    const user = requireUser(req);
    const doc = getLoadedKit(res);
    const body = regenerateInputSchema.parse(req.body ?? {});
    const section = body.section as Section;

    if (baseVersionConflict(doc.version, body.baseVersion)) {
      throw await versionConflictError(doc);
    }
    await assertNoRunningJobForKit(String(doc._id));
    await assertJobThrottle(user.id);

    if (section === 'schedule') {
      // Cheap and deterministic (core/schedule.ts is pure code, no LLM): run
      // it inline instead of enqueueing a job. We still record a Job document
      // that is already 'completed' so the response and client polling stay
      // uniform ({jobId} -> poll -> completed).
      builderKitOf(doc);
      const updated = await applyKitMutation(res, body.baseVersion, (kit) => {
        if (body.days !== undefined && body.days !== kit.schedule.days_available) {
          kit.schedule.days_available = body.days;
        }
        recomputeSchedule(kit);
        recomputeCoverageInPlace(kit);
      });
      const now = new Date();
      const job = await Job.create({
        kitId: String(doc._id),
        userId: user.id,
        type: 'regenerate',
        section: 'schedule',
        days: body.days,
        status: 'completed',
        progress: [
          {
            step: 'schedule',
            message: 'Schedule rebuilt deterministically in code',
            at: now.toISOString(),
          },
        ],
        checkpoints: {},
        inputHash: doc.input.inputHash,
        startedAt: now,
        finishedAt: now,
      });
      res.status(202).json({ jobId: String(job._id), kit: kitToJson(updated) });
      return;
    }

    builderKitOf(doc);
    getGenerator(); // 503 GENERATOR_UNAVAILABLE when the pipeline is not wired
    const job = await Job.create({
      kitId: String(doc._id),
      userId: user.id,
      type: 'regenerate',
      section,
      days: body.days,
      status: 'queued',
      progress: [],
      checkpoints: {},
      inputHash: doc.input.inputHash,
    });
    startJob(String(job._id));
    res.status(202).json({ jobId: String(job._id) });
  }),
);

// ---------------------------------------------------------------------------
// Routes: brief / role / requirements
// ---------------------------------------------------------------------------

kitsRouter.patch(
  '/:id/brief',
  loadKit,
  asyncHandler(async (req, res) => {
    const body = briefPatchSchema.parse(req.body ?? {});
    builderKitOf(getLoadedKit(res));
    const updated = await applyKitMutation(res, body.baseVersion, (kit) => {
      kit.company_brief = {
        ...kit.company_brief,
        ...(body.summary !== undefined ? { summary: body.summary } : {}),
        ...(body.what_they_do !== undefined ? { what_they_do: body.what_they_do } : {}),
      };
    });
    res.json(kitToJson(updated));
  }),
);

kitsRouter.patch(
  '/:id/role',
  loadKit,
  asyncHandler(async (req, res) => {
    const body = rolePatchRequestSchema.parse(req.body ?? {});
    builderKitOf(getLoadedKit(res));
    const updated = await applyKitMutation(res, body.baseVersion, (kit) => {
      if (body.title !== undefined) kit.role.title = body.title;
      if (body.seniority !== undefined) kit.role.seniority = body.seniority;
      if (body.responsibilities !== undefined) kit.role.responsibilities = body.responsibilities;
    });
    res.json(kitToJson(updated));
  }),
);

kitsRouter.post(
  '/:id/requirements',
  loadKit,
  asyncHandler(async (req, res) => {
    const body = newRequirementRequestSchema.parse(req.body ?? {});
    const loaded = getLoadedKit(res);
    builderKitOf(loaded);
    const updated = await applyKitMutation(res, body.baseVersion, (kit) => {
      const id = nextId('r', kit.role.requirements.map((r) => r.id));
      const req_: Requirement = { id, text: body.text, kind: body.kind, priority: body.priority };
      kit.role.requirements.push(req_);
      recomputeCoverageInPlace(kit);
    });
    res.json(kitToJson(updated));
  }),
);

kitsRouter.patch(
  '/:id/requirements/:rid',
  loadKit,
  asyncHandler(async (req, res) => {
    const body = requirementPatchRequestSchema.parse(req.body ?? {});
    const loaded = getLoadedKit(res);
    const kit = builderKitOf(loaded);
    const existing = kit.role.requirements.find((r) => r.id === req.params.rid);
    if (!existing) throw new ApiError(404, 'NOT_FOUND', 'Requirement not found');
    const updated = await applyKitMutation(res, body.baseVersion, (k) => {
      const target = k.role.requirements.find((r) => r.id === req.params.rid);
      if (!target) throw new ApiError(404, 'NOT_FOUND', 'Requirement not found');
      if (body.text !== undefined) target.text = body.text;
      if (body.kind !== undefined) target.kind = body.kind;
      if (body.priority !== undefined) target.priority = body.priority;
    });
    res.json(kitToJson(updated));
  }),
);

kitsRouter.delete(
  '/:id/requirements/:rid',
  loadKit,
  asyncHandler(async (req, res) => {
    const loaded = getLoadedKit(res);
    const kit = builderKitOf(loaded);
    if (!kit.role.requirements.some((r) => r.id === req.params.rid)) {
      throw new ApiError(404, 'NOT_FOUND', 'Requirement not found');
    }
    const updated = await applyKitMutation(res, undefined, (k) => {
      deleteRequirement(k, req.params.rid);
    });
    res.json(kitToJson(updated));
  }),
);

// ---------------------------------------------------------------------------
// Routes: questions
// ---------------------------------------------------------------------------

kitsRouter.post(
  '/:id/questions/reorder',
  loadKit,
  asyncHandler(async (req, res) => {
    const body = reorderSchema.parse(req.body ?? {});
    builderKitOf(getLoadedKit(res));
    const updated = await applyKitMutation(res, body.baseVersion, (kit) => {
      reorderQuestions(kit, body.orderedIds);
    });
    res.json(kitToJson(updated));
  }),
);

kitsRouter.post(
  '/:id/questions',
  loadKit,
  asyncHandler(async (req, res) => {
    const body = newQuestionRequestSchema.parse(req.body ?? {});
    builderKitOf(getLoadedKit(res));
    const updated = await applyKitMutation(res, body.baseVersion, (kit) => {
      addManualQuestion(kit, {
        category: body.category,
        prompt: body.prompt,
        answer_outline: body.answer_outline,
        difficulty: body.difficulty as Question['difficulty'],
        requirement_ids: body.requirement_ids,
      });
      recomputeCoverageInPlace(kit);
    });
    res.json(kitToJson(updated));
  }),
);

kitsRouter.patch(
  '/:id/questions/:qid',
  loadKit,
  asyncHandler(async (req, res) => {
    const body = questionPatchSchema.parse(req.body ?? {});
    const loaded = getLoadedKit(res);
    const kit = builderKitOf(loaded);
    if (!kit.questions.some((q) => q.id === req.params.qid)) {
      throw new ApiError(404, 'NOT_FOUND', 'Question not found');
    }
    const patch: Partial<Pick<Question, 'prompt' | 'answer_outline' | 'difficulty' | 'category' | 'requirement_ids'>> = {};
    if (body.prompt !== undefined) patch.prompt = body.prompt;
    if (body.answer_outline !== undefined) patch.answer_outline = body.answer_outline;
    if (body.difficulty !== undefined) patch.difficulty = body.difficulty as Question['difficulty'];
    if (body.category !== undefined) patch.category = body.category;
    if (body.requirement_ids !== undefined) patch.requirement_ids = body.requirement_ids;
    const updated = await applyKitMutation(res, body.baseVersion, (k) => {
      applyQuestionEdit(k, req.params.qid, patch);
    });
    res.json(kitToJson(updated));
  }),
);

kitsRouter.delete(
  '/:id/questions/:qid',
  loadKit,
  asyncHandler(async (req, res) => {
    const loaded = getLoadedKit(res);
    const kit = builderKitOf(loaded);
    if (!kit.questions.some((q) => q.id === req.params.qid)) {
      throw new ApiError(404, 'NOT_FOUND', 'Question not found');
    }
    const updated = await applyKitMutation(res, undefined, (k) => {
      deleteQuestion(k, req.params.qid);
    });
    res.json(kitToJson(updated));
  }),
);

kitsRouter.post(
  '/:id/questions/:qid/pin',
  loadKit,
  asyncHandler(async (req, res) => {
    const body = pinRequestSchema.parse(req.body ?? {});
    const loaded = getLoadedKit(res);
    const kit = builderKitOf(loaded);
    if (!kit.questions.some((q) => q.id === req.params.qid)) {
      throw new ApiError(404, 'NOT_FOUND', 'Question not found');
    }
    const updated = await applyKitMutation(res, body.baseVersion, (k) => {
      togglePin(k, 'question', req.params.qid);
    });
    const question = (updated.kit as KitDocument).questions.find((q) => q.id === req.params.qid);
    res.json({ pinned: question?.pinned ?? false });
  }),
);

// ---------------------------------------------------------------------------
// Routes: flashcards
// ---------------------------------------------------------------------------

kitsRouter.post(
  '/:id/flashcards',
  loadKit,
  asyncHandler(async (req, res) => {
    const body = newFlashcardRequestSchema.parse(req.body ?? {});
    builderKitOf(getLoadedKit(res));
    const updated = await applyKitMutation(res, body.baseVersion, (kit) => {
      addManualFlashcard(kit, {
        front: body.front,
        back: body.back,
        requirement_ids: body.requirement_ids,
      });
    });
    res.json(kitToJson(updated));
  }),
);

kitsRouter.patch(
  '/:id/flashcards/:fid',
  loadKit,
  asyncHandler(async (req, res) => {
    const body = flashcardPatchSchema.parse(req.body ?? {});
    const loaded = getLoadedKit(res);
    const kit = builderKitOf(loaded);
    if (!kit.flashcards.some((f) => f.id === req.params.fid)) {
      throw new ApiError(404, 'NOT_FOUND', 'Flashcard not found');
    }
    const updated = await applyKitMutation(res, body.baseVersion, (k) => {
      applyFlashcardEdit(k, req.params.fid, {
        ...(body.front !== undefined ? { front: body.front } : {}),
        ...(body.back !== undefined ? { back: body.back } : {}),
        ...(body.requirement_ids !== undefined ? { requirement_ids: body.requirement_ids } : {}),
      });
    });
    res.json(kitToJson(updated));
  }),
);

kitsRouter.delete(
  '/:id/flashcards/:fid',
  loadKit,
  asyncHandler(async (req, res) => {
    const loaded = getLoadedKit(res);
    const kit = builderKitOf(loaded);
    if (!kit.flashcards.some((f) => f.id === req.params.fid)) {
      throw new ApiError(404, 'NOT_FOUND', 'Flashcard not found');
    }
    // Drop any practice record for the card before mutating the kit.
    await Kit.updateOne({ _id: loaded._id }, { $unset: { [`practice.${req.params.fid}`]: '' } });
    const updated = await applyKitMutation(res, undefined, (k) => {
      deleteFlashcard(k, req.params.fid);
    });
    res.json(kitToJson(updated));
  }),
);

kitsRouter.post(
  '/:id/flashcards/:fid/confidence',
  loadKit,
  asyncHandler(async (req, res) => {
    const body = confidenceRequestSchema.parse(req.body ?? {});
    const loaded = getLoadedKit(res);
    const kit = builderKitOf(loaded);
    if (!kit.flashcards.some((f) => f.id === req.params.fid)) {
      throw new ApiError(404, 'NOT_FOUND', 'Flashcard not found');
    }
    if (baseVersionConflict(loaded.version, body.baseVersion)) {
      throw await versionConflictError(loaded);
    }
    // Practice telemetry: guarded write that deliberately does NOT bump the
    // kit version, so practicing never conflicts with builder edits.
    const record = {
      confidence: body.level,
      lastPracticedAt: new Date().toISOString(),
    };
    let updated: KitDoc | null = null;
    for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt++) {
      const base = attempt === 0 ? loaded : await Kit.findById(loaded._id);
      if (!base) throw new ApiError(404, 'NOT_FOUND', 'Kit not found');
      updated = await Kit.findOneAndUpdate(
        { _id: base._id, version: base.version },
        { $set: { [`practice.${req.params.fid}`]: record } },
        { new: true },
      );
      if (updated) break;
    }
    if (!updated) throw await versionConflictError(await Kit.findById(loaded._id));
    res.json(kitToJson(updated));
  }),
);

// ---------------------------------------------------------------------------
// Routes: schedule
// ---------------------------------------------------------------------------

kitsRouter.patch(
  '/:id/schedule',
  loadKit,
  asyncHandler(async (req, res) => {
    const body = schedulePatchSchema.parse(req.body ?? {});
    builderKitOf(getLoadedKit(res));
    const updated = await applyKitMutation(res, body.baseVersion, (kit) => {
      // Manual day edits replace the day list; days_available (the day count
      // fixed at creation / schedule regeneration) is intentionally untouched.
      kit.schedule.days = body.days;
    });
    res.json(kitToJson(updated));
  }),
);
