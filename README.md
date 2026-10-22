# AI Interview Prep Kit

Turn a pasted job description into a personalised interview preparation kit: the app researches the company, extracts the role's requirements, generates a question bank, flashcards and a day-by-day study schedule, lets you reshape any part of it, and tracks your practice — and the same pipeline runs headless through a single batch command.

Built for assessment **FS-AI-INTERVIEW-01**.

## Live demo

- App: https://interview-prep-kit-j9oh.onrender.com (single service — frontend and API are both reachable at this origin; the free instance sleeps when idle, so the first request can take ~30–60 s to wake)
- Repository: https://github.com/aditya-1310/AI_Interview_Prep

## Tech stack and why

| Layer | Choice |
| --- | --- |
| Frontend | Vite + React 18 + TypeScript + **Tailwind CSS v4** |
| Backend | Node.js + **Express** + TypeScript |
| Database | **MongoDB** (Mongoose, Atlas free tier) |
| LLM | Google **Gemini** (`gemini-3.5-flash`, fallback `gemini-3.1-flash-lite`) — genuine free tier |

**Why Vite instead of the preferred Next.js:** this app is a session-gated SPA with zero SEO surface, so server-side rendering buys nothing here. Serving the built client from the Express server means one deployment, one URL, same-origin session cookies, and half the free-tier failure modes — the "frontend and backend both reachable" requirement is satisfied by construction. The brief allows equivalent technologies with justification; everything else in the preferred stack (Node/Express, MongoDB, TypeScript, Tailwind) is kept as specified.

## Setup

### Local

```sh
git clone https://github.com/aditya-1310/AI_Interview_Prep.git
cd AI_Interview_Prep
npm install          # installs both workspaces (server + web)
cp .env.example .env # then fill in the values below
npm run dev          # API on :8787 (tsx watch) + client on :5173 (Vite, proxies /api)
```

Production-style single service: `npm run build && npm start` (serves the client from the API on :8787).

### Environment variables

| Variable | Purpose |
| --- | --- |
| `GEMINI_API_KEY` | Google Gemini API key (https://aistudio.google.com/apikey, free tier) |
| `GEMINI_MODEL` / `GEMINI_FALLBACK_MODELS` | Primary model and comma-separated fallbacks used on rate limits/outages |
| `GEMINI_MIN_CALL_GAP_MS` | Minimum gap between LLM calls (free-tier pacing). Default 4500 ms; on a fresh key with quota headroom, 2000 ms makes batches noticeably faster |
| `MONGODB_URI` | MongoDB connection string |
| `SESSION_SECRET` | Signing secret for session cookies |
| `PORT` | API/client port (default 8787) |
| `ALLOW_PRIVATE_ADDRESSES` | Lets the crawler fetch loopback/private hosts. **true for local evaluation** (the grader serves company sites from localhost), **false in production** (SSRF protection) |
| `CLIENT_ORIGIN` | Dev-only CORS origin for the Vite server |

### Batch entry point (exact)

```sh
npm run evaluate -- --input <cases.json> --output <kits.json>
```

Input: `[{"id","jd","company_url","days"}]`. Output envelope: `{"version":"1.0","generated_at","kits":[{"id","status","kit","error"}]}` — one entry per case, `failed` reserved for cases that could not produce a kit at all (unreachable company sites stay `ok` with recorded warnings). To exercise it against the bundled local company site:

```sh
node fixtures/serve.mjs &          # serves fixtures/acme on http://localhost:8099
npm run evaluate -- --input fixtures/cases.json --output kits.json
```

Five cases complete well inside the fifteen-minute budget. Verified full run: **5/5 ok in ~13.5 minutes wall-clock** — measured with the primary model's daily quota already exhausted (every LLM call served by the fallback model after rate-limit backoff), per-case times 45–282 s. With a fresh key it is comfortably faster. All kits validate against Appendix A on every run: exact day counts (tested 2–7 days; the algorithm covers 1–60), integer minutes, valid question references, zero uncovered must-haves. Edge cases verified in the same run: a two-line JD produces an honest thin kit (`THIN_JD`, nothing invented), an unreachable company site stays `ok` with a `SITE_UNREACHABLE` warning, and a site with no hiring page reports `NO_HIRING_PAGE` without failing.

## Architecture

```
web/ (Vite SPA)  ──/api──▶  Express API  ──▶  MongoDB (users, kits, jobs)
                                 │
                                 ▼
                        services/pipeline (shared by API + CLI)
   extract ─▶ crawl ─▶ discussion ─▶ brief ─▶ questions(per category)
        ─▶ coverage(code) ─▶ gap pass ─▶ flashcards ─▶ schedule(code) ─▶ validate
```

- `server/src/core` — kit contracts (Zod, Appendix A field-exact), the deterministic coverage check, the schedule allocator, and the builder merge rules. Pure, fully unit-tested.
- `server/src/services` — Gemini client (retries/fallback/JSON repair), site crawler, discussion search, per-category generation, and the orchestrating pipeline with per-stage checkpoints.
- `server/src/routes` + `models` + `jobs` — auth, kit CRUD/builder endpoints, in-process job runner.
- `server/src/cli` — the batch runner; same pipeline the app uses, no parallel implementation.
- `web/src` — React SPA: dashboard, generation progress, builder, practice, weak spots.

## Retrieval approach and sources

- **Company site crawl (ranked frontier):** fetch the entry page, extract and resolve same-host links (relative links included), score them on anchor text + path keywords (careers, hiring, interview, jobs, about, team, handbook, engineering blog…), fetch the best, and re-scan those for more links — depth ≤ 3, ≤ 15 pages, one page per 750 ms per host. A hiring page buried behind an about/handbook page is still found; no path is hard-coded. robots.txt is fetched per host and honored; failures are skipped and recorded, never fatal.
- **Public discussion:** Hacker News (Algolia search API) and Reddit (public search JSON) for "`<company>` interview" threads. Nothing found is reported honestly as a warning.
- **Prompt-injection stance:** the JD and every fetched page are wrapped as untrusted data with an explicit system instruction that they are content to process, never instructions to follow.

## Pipeline sequencing (and who owns each step)

| Step | Owner | Responsibility |
| --- | --- | --- |
| Extract requirements | LLM | must/nice and technical/behavioural/domain straight from the JD's wording; no invention (thin JD → thin kit) |
| Crawl + discussion | code | bounded, ranked, honest research with warnings |
| Company brief | LLM | written only from fetched evidence; says so when evidence is thin |
| Questions | LLM, **one call per category** | hiring evidence changes behavioural/company-fit prompts |
| Coverage check + gap pass | **code** | deterministic set-difference; gaps trigger targeted regeneration, re-checked after; max 3 generation passes |
| Flashcards | LLM | from the final question/requirement set |
| Schedule | **code** | deterministic allocation (below); the model is never asked for arithmetic |
| Validate | code | full Zod validation against Appendix A before anything is saved |

Scheduling and coverage are deliberately never delegated to the model — the brief calls this out, and the unit tests pin it.

## Generated, edited and pinned state

Every question/flashcard carries `origin` (`generated`|`manual`), `item_state` (`pristine`|`edited`) and `pinned`.

- Regenerating a section replaces only **pristine generated** items. Manual, edited and pinned items always survive.
- Sections not being regenerated are untouched. Regeneration applies onto the freshest kit document when it finishes, so edits made **while a regeneration is running** are preserved: concurrent edits win over the regenerated content, questions added meanwhile are kept (a regenerated item whose id collides with one you just added gets a fresh id), deletions stay deleted, and a brief you edited mid-run is never overwritten. This merge behavior is pinned by tests (`server/tests/api-regen-merge.test.ts`).
- After a category regeneration the schedule is repaired in code: removed ids dropped, new questions slotted into the best-matching day, full rebuild only if a day was left empty.
- Deleting a question repairs schedule references and recomputes coverage; deleting a requirement strips its references everywhere.

## Schedule allocation

Deterministic arithmetic in `core/schedule.ts`: per-question minutes by difficulty (1→20, 2→30, 3→45); ordering is must-have-covering first, harder first within a tier, categories kept contiguous; the ordered list is partitioned into **exactly** the requested days (1–60). More days than questions → material days first, then spaced review days at half minutes (integers). Every question is scheduled, so every must-have requirement (which by the coverage invariant has a question) appears in the schedule.

## Practice mode

Flip cards one at a time, record confidence 1–3, see covered/uncovered. The next session is ordered: **never-practiced cards first, then ascending confidence, then least-recently-practiced** — a deliberate, explainable confidence-weighted sort rather than a full spaced-repetition engine.

## Creative feature: Weak Spots

A per-kit weakness report derived from practice data: uncovered must-have requirements first, then requirements ranked by average card confidence (unpracticed cards count as zero), with jump-to-practice links. It addresses the real pre-interview problem — "with two days left, what do I actually drill?" — using data the app already holds.

## Design decisions, trade-offs, limitations

- **Single service** over split frontend/backend deploys: simpler, one URL, no cross-origin cookies; the trade-off is no SSR (unneeded here).
- **Retries:** LLM calls retry 429/5xx with exponential backoff (2/8/20/45 s) then fall back models; the batch runner isolates case failures and never aborts the run.
- **Failure semantics:** `failed` only when no kit could be produced (LLM dead after retries, coverage unreachable, empty JD). Partial research is `ok` with warnings recorded in the kit.
- **Duplicate submissions:** identical (jd, company_url, days) while a job is running returns the running job; after completion returns the existing kit unless `force` is set.
- **Limitations:** discussion search depends on free public endpoints and is thin for small companies (reported honestly); practice ordering is a simple sort, not SM-2; the crawler is keyword-ranked, not semantic.
- **Tests:** `npm test` — schedule allocation (1/5/60 days, integer minutes, must-have coverage, harder-earlier), coverage checking, Appendix A/B contract validation, regeneration merge/deletion repair, pipeline behaviors (SSRF, robots, relative links, gap closure), and API auth/ownership.

## Known limitations

Free-tier Gemini can throttle under sustained load — the pipeline backs off and falls back, but a badly rate-limited run takes longer. The deployed free-tier service sleeps when idle (first request takes ~30–60 s to wake).
