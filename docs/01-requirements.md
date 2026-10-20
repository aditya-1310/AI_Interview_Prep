# AI Interview Prep Kit Requirements Review

Status: Draft for scope review

Source: assessment FS-AI-INTERVIEW-01, Sections 1 to 14, submission requirements, FAQ, and Appendices A and B

Acceptance evidence: Pending implementation

This checklist translates the assignment into reviewable product behavior. Requirements marked **Specified** come from the brief. Items marked **Proposed** are engineering choices to resolve during design. No implementation or acceptance result is claimed here.

## Specified product requirements

| ID | Source | Acceptance criterion |
| --- | --- | --- |
| R01 | Section 1 | Register, log in, and log out securely. Protected pages and endpoints reject signed-out or invalid sessions. Users can read and modify only their own kits. |
| R02 | Section 2 and overview | Accept a pasted job description, company website, and days available. Support multiple roles, including a file of description-and-company pairs. |
| R03 | Section 2 | Crawl the company site, discover and rank links, and seek company information and hiring-process material. A fixed list of guessed paths alone is insufficient. |
| R04 | Sections 2 and 3 | Search for public interview-process discussion. Skip and report inaccessible sources, rate-limit requests, back off on failure, and respect robots.txt and site terms. Document sources. |
| R05 | Section 3 | Sequence extraction, retrieval, research, and generation deliberately. Technical and behavioural requirements lead to distinct generation instructions; hiring evidence affects the questions. |
| R06 | Sections 3 and 4 | Code computes requirement coverage from question references, generates questions for gaps, and checks again. A completed kit cannot ship with uncovered must-have requirements. Explain the pass limit and stopping behavior. |
| R07 | Section 5 and Appendix A | Preserve the exact required kit field names and enums. IDs are stable within a kit. Requirements distinguish must from nice. Difficulty is 1 to 3. Durations are integer minutes. |
| R08 | Section 6 and overview | Allow edits to kit content, inline edits to briefs, questions, answer outlines and flashcards, question reordering and category moves, manual question/card creation, and deletion. Scope the controls for role and schedule editing in the design. |
| R09 | Section 6 | Regenerate the company brief, a question category, or the schedule independently. Preserve edits elsewhere and manually authored or edited questions within a regenerated category. Explain generated, edited, and pinned state. |
| R10 | Section 7 | Reveal flashcard answers one at a time, persist confidence and coverage, and prioritise less confident cards in the next session. Explain the ordering rule. |
| R11 | Section 8 | Allocate the schedule in code across exactly the requested days. Every day has a focus, valid question IDs, and integer minutes. Every must-have requirement appears through scheduled questions; harder and higher-priority material comes earlier. |
| R12 | Section 9 and Appendix B | Provide the exact batch command and output contract below. Run the same full pipeline as the app, preserve each case's day count, isolate failures, and finish five cases within fifteen minutes including retries. |
| R13 | Section 10 and FAQ | Handle invalid URLs, 404s, timeouts, absent hiring/about pages, thin descriptions, no public discussion, invalid/incomplete model output, provider limits/failures, duplicate submissions, and 1-day and 60-day schedules. Report limited evidence honestly. |
| R14 | Section 11 | Validate fetched URLs, reject private and loopback addresses in production, bound content types and sizes, and treat pasted and retrieved text as untrusted content rather than model instructions. |
| R15 | Section 12 | Build reusable frontend components with clear state ownership, loading/empty/error states, immediate editing and reordering, phone/laptop usability, and keyboard navigation. Next.js and Tailwind are specified, with justified stack alternatives allowed by the brief. |
| R16 | Section 13 | Separate retrieval, extraction, generation, scheduling, and persistence. Validate requests and generated kits before saving, persist resumable kit work, expose structured errors, and explain slow, interrupted, and duplicate generation. |
| R17 | Section 14 | Use JavaScript or TypeScript, maintain meaningful commit history, and automate tests for scheduling, coverage, and structure validation. |
| R18 | Deployment and submission | Provide reachable frontend and backend, secure documented environment variables, a GitHub repository, a complete README, and a three-to-four-minute walkthrough. Free tiers are expected. |

## Exact external contracts

The kit must contain these fields. This inventory is for review; the implementation must encode the full contract and validate its invariants.

| Object | Required fields |
| --- | --- |
| `source` | `company`, `company_url`, `role`, `location`, `jd_chars`, `researched_at`, `pages_used` |
| `company_brief` | `summary`, `what_they_do`, `sources` |
| `role` | `title`, `seniority`, `responsibilities`, `requirements` |
| Each requirement | `id`, `text`, `kind`, `priority` |
| Each question | `id`, `requirement_ids`, `category`, `prompt`, `answer_outline`, `difficulty` |
| Each flashcard | `id`, `front`, `back`, `requirement_ids` |
| `schedule` | `days_available`, `days` |
| Each schedule day | `day`, `focus`, `question_ids`, `minutes` |
| `coverage` | `uncovered_requirement_ids`, `passes` |

Requirement `kind` is `technical`, `behavioural`, or `domain`; `priority` is `must` or `nice`. Question `category` is `technical`, `behavioural`, `system-design`, or `company-fit`. Question references in the schedule must resolve to existing questions. Additional fields are allowed where useful.

The repository root must expose:

```sh
npm run evaluate -- --input <cases.json> --output <kits.json>
```

Input is an array of cases with `id`, `jd`, `company_url`, and `days`. Output is an object with `version: "1.0"`, `generated_at`, and `kits`. Each result retains its input `id` and contains either `status: "ok"`, a `kit`, and `error: null`, or `status: "failed"`, `kit: null`, and an error containing `code` and `message`.

Partial research remains `ok` if a kit can be produced, with the gaps recorded in the kit. Reserve `failed` for inability to produce a kit at all. The unreachable-company error in Appendix B is an example shape; the surrounding prose and FAQ clarify that unavailable research alone need not make a case fail.

The runner must support locally served company websites and relative links, work from a clean clone after the documented install step, and read credentials from documented environment variables. Design must reconcile that local evaluation requirement with production URL restrictions.

## Proposed acceptance scenarios

These scenarios provide evidence for the specified behavior; exact fixtures and assertions belong in the EDD and implementation tasks.

| Scenario | Expected review evidence |
| --- | --- |
| Normal description with must and nice requirements | Extracted requirements reflect the wording, have stable IDs, and link to relevant questions. |
| First generation leaves a must-have gap | Deterministic check identifies it; a subsequent generation call closes it; coverage is checked again. |
| Two-line description | A small, honest kit with explicit evidence limitations and no invented requirements. |
| Local company site with nested relative links | Crawler discovers relevant material without assuming a public hostname or known hiring path. |
| Company site unavailable or no hiring page | Research warning is recorded; generation continues if it can produce a valid kit. |
| Model returns malformed output or provider throttles | Bounded recovery produces valid output or a useful structured failure within the time budget. |
| Batch contains one unrecoverable case | Other cases continue and every case has one result entry. |
| User requests 1 day or 60 days | Exact day count, integer durations, valid question references, and scheduled must-have coverage. |
| User edits a question and adds another before category regeneration | Both survive; other sections retain their changes. |
| User changes content while regeneration is running | The merge behavior protects the newer user work. |
| User deletes or moves a question | Builder state, references, coverage, and schedule remain consistent or explicitly require repair. |
| Another user requests a kit by ID | Access is denied by the backend. |
| Practice session repeats | Stored confidence affects the next ordering and coverage remains visible. |

## Decisions for the EDD

- **Proposed:** Start with the preferred stack; keep the CLI and HTTP application on shared pipeline code. Decide which services the clean-clone CLI actually needs.
- **Proposed:** Design a bounded retry and coverage policy with explicit failure semantics. Never present an incomplete must-have result as a completed kit.
- **Open:** Select current free-tier LLM, public-discussion search, and hosting services after checking credentials, quotas, token limits, and runtime behavior.
- **Open:** Choose job execution and recovery behavior, progress transport, duplicate handling, and persistence boundaries.
- **Open:** Define item ownership metadata, merge rules, concurrent edits, pin behavior, and how deletion or manual edits affect coverage and scheduling.
- **Open:** Define deterministic topic ordering, duration estimates, long schedules with little material, and confidence ordering for unseen cards.
- **Open:** Define accepted upload format, validation errors, and how days are supplied per uploaded case. The CLI JSON input is mandatory; the UI upload format is a design choice.
- **Open:** Define an explicit local evaluation retrieval policy while keeping the public application restricted.

## Scope boundaries and delivery priority

The creative feature is optional and deferred until mandatory behavior passes. Email verification, password reset, role hierarchies, job aggregation, CV tools, job applications, audio/video simulation, payments, and team/sharing features are outside the requested scope.

The published evaluation assigns 55 points to automated checks and 45 to human review. Requirement extraction is worth 20 points; coverage/scheduling and builder behavior are worth 15 each. This supports prioritising pipeline correctness and edit preservation while still delivering the full mandatory application.

The README must cover setup and batch commands, provider/model, architecture, retrieval sources, pipeline steps, generated/edited/pinned state, scheduling, design decisions, trade-offs, known limitations, and any optional feature. The walkthrough must show end-to-end creation, research and gap closure, editing/reordering and safe regeneration, practice, schedule, and a defensible design decision.
