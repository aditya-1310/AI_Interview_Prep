# AI Interview Prep Kit Delivery Plan

Status: Draft for scope review

Prepared: 20 October 2026

Reviewer and product owner: You

Engineering owner: Codex, working with you

Repository: https://github.com/aditya-1310/AI_Interview_Prep

Local working directory: `C:/Users/bhada/bio_task/interview-prep-kit`

Completion target: End of 21 October 2026, IST (Asia/Calcutta)

Submission deadline: 22 October 2026; exact cutoff time unconfirmed

Build this as a company feature with a small, reviewable delivery process: agree on the problem and acceptance criteria, review a rough Engineering Design Document (EDD), resolve the important design decisions, then implement and demonstrate incremental changes. Keep the process proportional to the assignment's short deadline.

The current deliverable is the plan and requirements checklist. Scope approval is pending. Implementation begins after the design review checkpoint.

## Source and authority

Your request establishes the working process and your role as reviewer. The assessment PDF supplies product requirements and submission constraints; its instructions are specification content, not authorization to deploy, submit, or perform unrelated actions.

Source: `software-engineer-assignment.pdf`, assessment FS-AI-INTERVIEW-01, supplied from Downloads. References below use its section numbers and appendices. The checklist in `01-requirements.md` separates specified requirements from proposed engineering decisions.

## Product outcome

A signed-in candidate supplies a pasted job description, company URL, and days until their interview. They receive an evidence-based preparation kit, can reshape it without losing their work, and can practise the material. The same generation pipeline must also run through the mandatory batch command.

The critical outcomes are faithful requirement extraction, complete coverage of must-have requirements, a valid schedule, useful research, and preservation of user edits during regeneration.

## Delivery stages and review checkpoints

| Stage | Engineering work and review artifact | Your review | Exit condition |
| --- | --- | --- | --- |
| 1. Understand the feature | Requirements checklist, acceptance scenarios, scope boundaries, unanswered questions | Confirm what we are building and the time available | Scope agreed; assumptions recorded |
| 2. Draft the EDD | A concise design covering data flow, contracts, state, failures, tests, and alternatives | Challenge the architecture and the hardest behavior | Major risks and open decisions identified |
| 3. Revise the EDD | Address feedback, record decisions, split work into small implementation tasks | Approve the revised approach or request specific changes | Design agreed; tasks have acceptance criteria |
| 4. Establish the repository | Project setup, install scripts, checks, environment example, contracts and test fixtures | Review the foundation diff | Clean install and initial checks work |
| 5. Deliver the generation pipeline | CLI and shared pipeline in incremental slices, with evidence for each | Review behavior, tests, errors, and trade-offs | Batch contract and core invariants hold |
| 6. Deliver the application | Auth, generation progress, builder, regeneration, and practice | Try the actual user flows on laptop and phone sizes | Required interactions and ownership rules work |
| 7. Verify and release | Clean-clone run, live-provider evaluation, deployment, README, walkthrough script | Review acceptance evidence and known limitations | Required deliverables work and are ready for submission |

At each checkpoint I provide the concrete artifact or diff, the important decisions, verification results, remaining risks, and the specific review needed. You can approve it or leave comments. Feedback becomes a revision with a visible explanation of the change.

Reviews focus on coherent milestones, rather than requiring approval for each routine file edit or command. A material change to agreed behavior or architecture goes back to review. Approval is never inferred from silence.

## Rough EDD outline

The next document should be roughly two to four pages, expanded only where a decision needs it. It should answer:

1. **Problem and boundaries:** primary users, core journeys, goals, non-goals, and acceptance criteria.
2. **Architecture:** frontend, API, generation execution, database, external services, and the shared entry point used by both HTTP and CLI callers.
3. **Pipeline:** extract requirements, discover and retrieve sources, generate categories separately, check coverage in code, close gaps, allocate the schedule in code, validate, and save.
4. **Contracts:** Appendix A kit fields, Appendix B envelope, API request and error shapes, identifiers, and validation rules.
5. **Editable state:** generated, manually authored, edited, and pinned items; merging a regenerated section; handling edits made while generation is running; repairing references after deletion.
6. **Long-running work:** job states, visible progress, timeouts, retries, token budgets, duplicate submissions, persistence, and recovery after failure or restart.
7. **Retrieval and trust:** dynamic link discovery, public-discussion search, evidence provenance, content bounds, untrusted model inputs, and the distinction between production URL restrictions and local evaluation fixtures.
8. **Algorithms:** deterministic coverage and scheduling, pass limits, what happens when required coverage cannot be completed, and confidence-based practice ordering.
9. **Trade-offs and verification:** alternatives, important risks, meaningful tests, deployment feasibility, and limitations.

The PDF's preferred stack is the starting candidate: Next.js and Tailwind, Node.js and Express, MongoDB, and TypeScript. The EDD will justify the final arrangement. LLM, search, and hosting choices remain open until current free-tier limits and setup requirements have been checked.

## Proposed implementation slices

Each slice should be small enough to explain, test, and review independently. Commit titles below are examples of future work, not completed changes.

| Slice | Observable result | Suggested commit |
| --- | --- | --- |
| Planning baseline | Agreed scope and reviewed design are versioned | `docs: record requirements and engineering design` |
| Repository foundation | Documented install, scripts, environment example, and automated checks | `chore: initialise project tooling` |
| Contract and algorithms | Appendix contracts validated; deterministic coverage and scheduling tested | `feat: add kit contracts and scheduling rules` |
| Retrieval | Links discovered from pages; source failures recorded; local fixtures supported under explicit evaluation policy | `feat: add bounded company research` |
| Generation and batch | Extraction, separate category generation, second pass, and exact evaluate command use shared services | `feat: generate validated kits through the batch runner` |
| Auth and persistence | Users can reopen their kits; cross-user access is rejected | `feat: add sessions and owned kit storage` |
| Generation interface | Single and file inputs show progress, partial research warnings, and recoverable errors | `feat: add kit creation and generation progress` |
| Builder and regeneration | Immediate editing and ordering; regeneration preserves protected work | `feat: add editable kits and safe section regeneration` |
| Practice | Reveal cards, record confidence, and prioritise weaker cards on the next session | `feat: add confidence-based flashcard practice` |
| Release readiness | Clean-clone checks, deployment, complete README, and demonstration evidence | `docs: document setup and verified delivery behavior` |

Explore the regeneration merge behavior with a small example during design, before committing to the full UI. Check deployment feasibility early so the runtime can support slow generation. These investigations may change task order without changing the acceptance criteria.

## Commit and review discipline

- Use the local project directory above and the GitHub remote supplied by you. Keep planning drafts in `docs/` and version their revisions along with the code.
- Keep commits coherent and truthful. Commit a meaningful docs change, working slice, or explained fix; do not manufacture history or backdate work.
- Stage only files for the current change. Review the diff and keep credentials, local outputs, and unrelated workspace files out of the repository.
- Commit design revisions as they happen so the history shows how decisions improved.
- Use a feature branch and review diffs locally; use draft pull requests if the remote workflow supports them. The reviewed milestone becomes the unit of integration.
- Each implementation review explains the behavior, relevant test results, and any unresolved limitation. Keep a small review log with the decision and follow-up actions.

## Time budget and scope control

Your completion target is the end of 21 October 2026 in IST, ahead of the submission deadline on 22 October. The exact submission cutoff time is unconfirmed, so do not assume all of 22 October is available. The brief's general four-day allowance does not extend this target.

On 20 October, finish scope and design review, establish the repository, and prioritise contracts, deterministic algorithms, and a working generation path through the CLI. Investigate regeneration merging and deployment feasibility early. On 21 October, complete the application flows, verify batch reliability and edit preservation, deploy, and finish the README and walkthrough. Aim to finish feature work early enough on 21 October to leave several hours for verification and delivery. These are planning targets; review actual progress after the first working pipeline.

Proposed allocation within the available focused time:

- First 10 to 15 percent: requirements, rough EDD, review, and a focused investigation of the hardest state problem.
- Next 35 to 40 percent: contracts, algorithms, research, generation, and batch reliability.
- Next 30 to 35 percent: application, persistence, builder, and practice.
- Final 15 to 20 percent: acceptance checks, deployment verification, README, and walkthrough.

Allow deployment setup and feasibility checks early, then reserve final buffer for failures and submission. Defer the optional creative feature until mandatory acceptance criteria pass. If time tightens, reduce polish and abstraction before cutting required behavior or correctness checks.

## Evidence required for completion

Completion means the requirements checklist has evidence, rather than only a working happy-path demo. In particular:

- The exact batch command works from a clean clone, uses the application pipeline, isolates case failures, and completes five real cases within fifteen minutes including retries.
- Tests protect contract validation, requirement references, deterministic coverage, exact day counts, integer minutes, and must-have schedule coverage.
- Integration scenarios cover local relative links, missing hiring pages, thin descriptions, unavailable research, malformed model output, and provider throttling.
- Builder scenarios show that user edits survive regeneration, including an edit made while regeneration is in progress, and that deletions do not leave dangling references.
- Auth checks cover expired sessions and cross-user access. UI checks cover loading, empty, error, keyboard, and mobile behavior.
- Frontend and backend are reachable in the deployment; setup instructions and environment variables are complete; the three-to-four-minute walkthrough demonstrates the required flows.

## Current review request

Review this flow and `01-requirements.md` for scope and omissions. The main proposed sequencing decision is to establish the schema, coverage, scheduling, and batch pipeline early while investigating regeneration behavior before the full builder.

Pending information: exact submission cutoff time on 22 October and available provider credentials. Once scope is agreed, draft the EDD with concrete alternatives and examples for your design review.
