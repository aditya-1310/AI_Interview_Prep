# Walkthrough video script (3–4 minutes)

Target: cover every required topic. Record at a relaxed pace; clarity beats production value.

| # | Section | Time | What to show / say |
| --- | --- | --- | --- |
| 1 | Intro | 0:00–0:15 | "This is the AI Interview Prep Kit — paste a job description and a company site, and it researches the company and builds a structured prep kit you can edit and practise against." Show the login → dashboard flow quickly. |
| 2 | Create a kit | 0:15–0:50 | Paste a real JD + company URL, set days (e.g. 5). Submit. Show the step-by-step generation progress (extract → crawl → discussion → brief → questions → coverage → flashcards → schedule → validate) and name the steps aloud. Mention: questions are generated per category, and coverage + scheduling are computed in code, never by the model. |
| 3 | Research honesty | 0:50–1:10 | Open the company brief tab; point at sources. Mention the crawler ranks and follows links (no hard-coded paths) and that unreachable sources are warnings, not failures. If a research warning is present, show it. |
| 4 | The second pass | 1:10–1:30 | In the schedule/coverage area show `coverage.passes` (2 when the gap pass ran). Say: "the deterministic check found a must-have with no question, a targeted second generation closed it, and the code re-checked." (To guarantee a gap on camera, edit a question's requirement_ids first.) |
| 5 | Builder | 1:30–2:20 | Edit a question inline (immediate, debounced save). Reorder with the arrow buttons. Move one question to another category. Add a manual question. Delete one and show the schedule stayed consistent. |
| 6 | Safe regeneration | 2:20–2:50 | Edit a question, pin it, then regenerate that category. Point out the edited + pinned + manual items survived; only untouched generated ones were replaced. |
| 7 | Practice + schedule | 2:50–3:20 | Practise a few cards: reveal, rate confidence. Show coverage tracking and that a new session leads with the least-confident cards. Glance at the schedule days/minutes. |
| 8 | Weak spots + design decision | 3:20–3:45 | Show the Weak Spots tab. Close with one defended decision: "single-service Vite + Express instead of Next.js — no SEO surface, one deploy, same-origin sessions" (or the deterministic-schedule decision). |
| 9 | Batch command | 3:45–4:00 (optional) | Terminal: `npm run evaluate -- --input fixtures/cases.json --output kits.json` running; show one ok kit and one warning case in the output. |

Recording notes: use the deployed URL; resize the window between laptop and phone widths once during the builder section to demonstrate responsiveness; keep the terminal font large.
