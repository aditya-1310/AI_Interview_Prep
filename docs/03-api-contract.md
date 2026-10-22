# API Contract and Build Conventions

Internal working document for implementation. Fixes the seams between the web client, the Express API, and the generation pipeline so work can proceed in parallel. EDD: `02-edd.md`. Kit JSON: Appendix A of the assignment, extended as noted.

## Conventions (all contributors)

- Node 22, TypeScript strict, **ESM everywhere** (`"type": "module"`). Server runs via `tsx`, never emits JS. Web bundles with Vite.
- Tests: Vitest. Unit tests must not touch the network — inject/mocking only. File naming: `tests/core-*.test.ts`, `tests/pipeline-*.test.ts`, `tests/api-*.test.ts`.
- Do not run `git` commands; the orchestrator commits reviewed slices. Do not run `npm install`; required deps are pre-installed. Note any missing dep in your report instead.
- Errors always `{ "error": { "code": "SCREAMING_SNAKE", "message": "human readable", "details"?: object } }`.

## Directory ownership

| Area | Owner |
| --- | --- |
| `server/src/core/` (types, zod schemas, coverage, schedule, kit-state, ports) | foundation (already implemented — build against it, do not rewrite) |
| `server/src/services/` (gemini, extract, crawl, discussion, generate, pipeline) | pipeline |
| `server/src/cli/` (evaluate runner), `fixtures/` | pipeline |
| `server/src/models/`, `middleware/`, `routes/`, `db.ts`, `config.ts`, `index.ts` | api |
| `web/` | web |

## Kit document (Mongo `kits` collection)

```ts
{
  _id, userId,
  status: 'pending' | 'ready' | 'failed',
  version: number,                    // bumped on every write, optimistic concurrency
  input: { jd: string, companyUrl: string, days: number, inputHash: string },
  kit: {
    ...AppendixA,                     // exact field names from the assignment
    questions: (AppendixAQuestion & {
      origin: 'generated' | 'manual',
      item_state: 'pristine' | 'edited',
      pinned: boolean })[],
    flashcards: (AppendixACard & { origin, item_state, pinned })[],
    warnings: { code: string, message: string }[],   // research gaps etc.
  },
  practice: { [flashcardId: string]: { confidence: 1|2|3, lastPracticedAt: string } },
  createdAt, updatedAt
}
```

`jobs` collection: `{ _id, kitId, userId, type: 'generate'|'regenerate', section?, status: 'queued'|'running'|'completed'|'failed', progress: { step, message, at }[], checkpoints: Record<string, unknown>, error?, inputHash, startedAt, finishedAt }`

## REST surface (all under `/api`, session cookie auth; 401 when signed out, 404 for other users' kits)

Auth: `POST /auth/register {email,password}` · `POST /auth/login` · `POST /auth/logout` · `GET /auth/me → {user:{id,email}}`

- `POST /kits {jd, companyUrl, days, force?}` → `{kitId, jobId}` — dedupes on inputHash: if a **running** job with the same hash exists, returns that job; if a **completed** kit with the same hash exists, returns `{kitId, duplicate:true, jobId:null}` unless `force:true`.
- `POST /kits/batch {cases:[{jd, companyUrl, days}]}` → `{jobs:[{kitId, jobId}]}` (JSON file of pairs parsed client-side).
- `GET /kits` → `[{id, company, role, status, days, createdAt}]`
- `GET /kits/:id` → full kit document (includes `version`)
- `DELETE /kits/:id` → 204
- `GET /kits/:id/job` → latest job `{id, status, progress, error?}`
- `POST /kits/:id/job/retry` → `{jobId}` — resumes from checkpoints.
- `POST /kits/:id/regenerate {section}` where section ∈ `brief | technical | behavioural | system-design | company-fit | schedule` (schedule accepts optional `{days}`) → `{jobId}`. After a question-category regeneration the server repairs the schedule in place (drops removed ids, slots new questions into matching days, rebuilds only if a day ends up empty) — `core/kitState.ts` implements this.
- `PATCH /kits/:id/brief {summary?, what_they_do?}`
- `PATCH /kits/:id/role {title?, seniority?, responsibilities?}`
- `POST /kits/:id/requirements {text, kind, priority}` → manual requirement (id `rN` allocated like questions)
- `PATCH /kits/:id/requirements/:rid {text?, kind?, priority?}`
- `DELETE /kits/:id/requirements/:rid` (strips references from questions/flashcards, recomputes coverage)
- `POST /kits/:id/questions {category, prompt, answer_outline, difficulty, requirement_ids}` (manual → `origin:'manual'`)
- `PATCH /kits/:id/questions/:qid` (any of prompt/answer_outline/difficulty/category/requirement_ids; sets `item_state:'edited'`)
- `DELETE /kits/:id/questions/:qid` (repairs schedule + coverage in code)
- `POST /kits/:id/questions/reorder {orderedIds: string[]}` (full order)
- `POST /kits/:id/questions/:qid/pin` → toggle → `{pinned}`
- Flashcards: same POST/PATCH/DELETE under `/flashcards`, plus `POST /flashcards/:fid/confidence {level:1|2|3}` (records lastPracticedAt)
- `PATCH /kits/:id/schedule {days:[{day,focus,question_ids,minutes}]}` (manual schedule edit)

All mutating kit endpoints accept `baseVersion` in the body; on mismatch respond `409 {error:{code:'VERSION_CONFLICT', currentKit}}` — client resolves by re-applying to the fresh document. Success returns the updated kit document.

## Pipeline port (implemented in `services/pipeline.ts`, consumed by the API through DI)

```ts
// core/ports.ts
type ProgressFn = (step: string, message: string) => Promise<void> | void;
interface RunContext { onProgress: ProgressFn; saveCheckpoint(stage: string, data: unknown): Promise<void>; loadCheckpoint(stage: string): Promise<unknown | null>; }
interface PipelineInput { jd: string; companyUrl: string; days: number; }
interface PipelineResult { kit: KitDocument; warnings: Warning[]; }
interface KitGenerator {
  run(input: PipelineInput, ctx: RunContext): Promise<PipelineResult>;
  regenerate(kit: KitDocument, section: Section, ctx: RunContext): Promise<{ kit: KitDocument; warnings: Warning[] }>;
}
```

Stage names for progress/checkpoints: `extract`, `crawl`, `discussion`, `brief`, `questions`, `coverage`, `flashcards`, `schedule`, `validate`.

## Batch CLI (exact, from the assignment)

`npm run evaluate -- --input <cases.json> --output <kits.json>` at the repo root. Input: `[{id, jd, company_url, days}]`. Output envelope: `{version:"1.0", generated_at, kits:[{id, status:"ok"|"failed", kit|null, error:{code,message}|null}]}`. Max 2 cases concurrent, per-case isolation, continues after failure, retries with backoff. No Mongo, no auth — pipeline only.

## Web client

Routes: `/login`, `/register`, `/` (dashboard: kit list + new kit form + file upload), `/kits/:id` (builder: tabs for Brief · Questions · Flashcards · Schedule · Weak spots · warnings), `/kits/:id/practice`. Polls `GET /kits/:id/job` every 1500ms while a job is running. Inline edits are local-state-first, debounced PATCH (800ms) with `baseVersion`, conflict → toast + re-apply. Keyboard navigable, phone-first responsive, loading/empty/error states everywhere.

**Weak spots tab (creative feature, derived client-side — no backend needed):** aggregates practice confidence per requirement (via flashcard `requirement_ids`), uncovered must-haves, and never-practiced cards into a ranked "where you're weakest" list with a jump-to-practice link.
