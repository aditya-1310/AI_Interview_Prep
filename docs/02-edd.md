# Engineering Design Document — AI Interview Prep Kit

Status: Agreed for implementation (compressed schedule, 22 October 2026)

Source of truth: `software-engineer-assignment.pdf` (FS-AI-INTERVIEW-01). Requirements checklist: `01-requirements.md`. This document records the decisions; the two exact contracts (Appendix A kit structure, Appendix B batch envelope) are treated as immutable.

## 1. Stack decision

- **Frontend:** Vite + React + TypeScript + Tailwind CSS v4, served as a static bundle **by the Express server** in production.
- **Backend:** Node.js + Express + TypeScript, Mongoose + MongoDB Atlas.
- **LLM:** Google Gemini via REST (`gemini-3.5-flash` primary, `gemini-3.1-flash-lite` fallback), API key from env.
- **Tests:** Vitest.

**Why not Next.js (README will carry this too):** the brief allows equivalent technologies with justification. This app is a session-gated SPA with no SEO surface; server-side rendering buys nothing here. A single service that serves both the API and the built client means one deployment, one URL, no cross-origin cookies, and half the failure modes on a free tier — the deployment requirement ("frontend and backend both reachable") is satisfied by construction. Everything else in the preferred stack (Node/Express, MongoDB, TS, Tailwind) is kept as specified.

## 2. Repository layout

npm workspaces at the root, no build-output juggling: the server runs TypeScript directly via `tsx`, the client bundles with Vite. Shared kit contracts live in `server/src/contracts` (pure types + Zod schemas, no server imports) and are aliased into the client as `@contracts`.

```
/                     root workspace: dev/build/test/evaluate scripts
  fixtures/           local acme company site + batch cases.json for local e2e
  server/
    src/contracts/    kit types, Zod schemas, pipeline port interfaces
    src/services/     llm, extract, research (crawl + discussion), generate,
                      coverage, schedule, pipeline, kit-state
    src/models/       User, Kit, Job (Mongoose)
    src/routes/       auth, kits, jobs
    src/middleware/   session auth, error handling, rate limiting
    src/cli/          batch evaluate runner
    tests/            algorithms, contracts, merge rules, API
  web/                Vite + React + Tailwind client
```

## 3. Pipeline (the deliberate sequence)

One orchestration module used identically by the HTTP app and the CLI. Steps, each with progress events:

1. **Extraction** (LLM, JSON-schema mode): JD text → role fields + requirements (`kind`, `must|nice` taken from wording). Thin JDs produce few requirements; the prompt forbids invention.
2. **Site crawl** (code): fetch `company_url`, parse + rank same-host links (keyword scoring over anchor text and path: careers, hiring, interview, jobs, about, team, engineering, handbook, blog), fetch the top ~8 ranked pages. Honors robots.txt, per-host rate limit (~1 req/750ms), 10s timeout, 500KB size cap, HTML/text content types only, failures skipped and recorded.
3. **Discussion search** (code): bounded search of public discussion (Hacker News Algolia API, Reddit search JSON), skip-and-record on failure or nothing-found.
4. **Company brief** (LLM): from crawled pages + discussion, with `sources`; honest "could not find" language when research came up empty.
5. **Questions** (LLM, one call **per category**: technical, behavioural, system-design, company-fit): each question references requirement ids; hiring evidence shapes behavioural/company-fit prompts.
6. **Coverage check** (code, deterministic): see §5.
7. **Gap pass** (LLM): generate questions only for uncovered must-haves; re-check. Max 3 passes total (initial + 2 gap passes). Still uncovered → case failed (`COVERAGE_INCOMPLETE`) — a kit must not ship with uncovered must-haves.
8. **Flashcards** (LLM): from the final question/requirement set.
9. **Schedule** (code, deterministic): see §6.
10. **Validation + save**: full Zod validation of the kit against Appendix A before persisting.

Pasted JD text and every fetched page are wrapped as untrusted data (delimited blocks + system instruction: content, never instructions).

## 4. Kit state and the builder

Every question/flashcard carries:

- `origin`: `"generated"` | `"manual"` (user-authored)
- `state`: `"pristine"` | `"edited"` (any inline edit flips it)
- `pinned`: boolean (user explicitly protects an item from regeneration)

**Regeneration merge rules** (regenerating the brief, one category, or the schedule):

- Manual items and edited items and pinned items survive; only pristine generated items of that section are replaced.
- Sections not being regenerated are untouched.
- Regeneration runs as a job against the current kit document; user edits made while it runs land on the same document and win — the merge is applied server-side to the freshest state, per-item, so an edit-in-flight is never clobbered.
- Deletion repair (code): deleting a question removes its id from schedule days and recomputes coverage; deleting a requirement strips it from `requirement_ids` everywhere.
- After structural edits (add/delete/move), the schedule stays valid: dangling references are repaired in code; the user can regenerate the schedule independently.

## 5. Coverage algorithm (deterministic)

- Drop dangling requirement references from questions first (validation garbage in, garbage out).
- `uncovered = must-have requirement ids − ids referenced by any question`.
- Gap pass prompts per uncovered requirement (category mapped from `kind`: technical→technical, behavioural→behavioural, domain→technical).
- Re-check after each pass; record `passes`. Nice-to-have gaps are reported, never fatal.

## 6. Schedule algorithm (deterministic)

- Per-question minutes by difficulty: 1→20, 2→30, 3→45.
- Ordering: questions covering must-haves before nice-to-haves, harder first (difficulty desc) within each tier, categories kept contiguous so a day has one focus.
- `days <= questions`: contiguous partition into exactly `days` groups, every day ≥1 question, day minutes = sum of member minutes, focus = primary category + topic of the group.
- `days > questions`: material days first (as above), then review days cycling the ordered questions at half minutes; every day has a focus, valid ids, integer minutes.
- Exactly `days` days always (1..60 tested). Every must-have requirement appears in the schedule because every must-have has a question (§5 invariant) and every question is scheduled.

## 7. Long-running work, failures, duplicates

- Generation runs as a background **job** (Mongo `Job`: queued → running → completed/failed, progress steps with timestamps). The client polls; the UI shows step-by-step progress and partial-failure warnings.
- Recovery: each pipeline stage checkpoints its output on the job. A failed/restarted run resumes from the last completed stage instead of redoing LLM calls.
- Duplicate submissions: input hash (jd + company_url + days); a running job with the same hash returns the existing job.
- LLM robustness: JSON-schema responses, timeout 60s, retry on 429/5xx with exponential backoff (honoring server retry hints), fallback model, one JSON-repair retry. Batch: max 2 cases concurrent, per-case try/catch → `failed` envelope entry, never aborts the run.
- `failed` is reserved for: no producible kit at all (LLM dead after retries, coverage unreachable, JD empty). Unreachable company site or absent hiring page → kit still generated from the JD with recorded research warnings, status `ok`.

## 8. Security

- Sessions: express-session + Mongo store, httpOnly cookie, bcrypt password hashing. Cross-user kit access → 404. Expired session → 401 → client routes to login.
- SSRF: URL validation (http/https only); DNS resolution with private/loopback/link-local rejection **in production**. `ALLOW_PRIVATE_ADDRESSES=true` (documented in `.env.example`) unlocks local evaluation fixtures (`http://localhost:8099/acme/`); default in production is off.
- Fetch guard: content-type allowlist, size cap, timeout, robots.txt respected, global outbound rate limit.

## 9. Tests (Vitest)

- Schedule: exact day counts (1, 5, 60), integer minutes, valid references, must-have scheduling, harder-earlier ordering.
- Coverage: gap detection, dangling refs, pass accounting.
- Contracts: Appendix A Zod validation (field names exact, enums, types), Appendix B envelope.
- Kit state: regeneration merge preserves manual/edited/pinned; deletion repair; concurrent-edit merge.
- API: auth wall, ownership, kit CRUD happy paths.

## 10. Deployment

Single service on a free tier (Render blueprint in repo). Env vars documented in `.env.example`: `GEMINI_API_KEY`, `GEMINI_MODEL` + fallbacks, `MONGODB_URI`, `SESSION_SECRET`, `PORT`, `ALLOW_PRIVATE_ADDRESSES`, `CLIENT_ORIGIN` (dev CORS). Build = `npm run build` (client bundle + no server emit, runs via tsx). Walkthrough script + README cover the mandatory video topics.

## 11. Trade-offs and known limitations

- No SSR (see §1). Practice ordering is a simple confidence-weighted sort (unseen = lowest confidence, then ascending confidence, least-recently-practiced first), not full spaced repetition — chosen for explainability.
- Discussion search relies on free public endpoints (HN Algolia, Reddit JSON); both can be thin for small companies — reported honestly rather than substituted with fabrication.
- The creative feature is deferred until the mandatory scope is green.
