// LLM generation steps. Each category of questions is a SEPARATE call with
// DIFFERENT instructions (the sequencing is graded): technical questions drill
// requirements, behavioural questions target mentoring/communication-type
// requirements, system-design only runs when technical requirements exist, and
// company-fit is shaped by the hiring evidence actually found on the site.
// Validation, id assignment and state flags are done in code, never the model.

import { z } from 'zod';
import type { Warning } from '../core/types';
import type { CompanyBrief, QuestionCategory, Requirement } from '../core/types';
import type { CrawlResult } from './crawl';
import type { DiscussionResult } from './discussion';
import type { LlmClient } from './gemini';
import { UNTRUSTED_DATA_RULE, capForPrompt, dataBlock } from './prompt';

/** A generated question before code assigns ids/state. */
export interface RawQuestion {
  requirement_ids: string[];
  category: QuestionCategory;
  prompt: string;
  answer_outline: string;
  difficulty: 1 | 2 | 3;
}

export interface RawFlashcard {
  front: string;
  back: string;
  requirement_ids: string[];
}

const QUESTIONS_SCHEMA = {
  type: 'OBJECT',
  properties: {
    questions: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          requirement_ids: { type: 'ARRAY', items: { type: 'STRING' } },
          prompt: { type: 'STRING' },
          answer_outline: { type: 'STRING' },
          difficulty: { type: 'INTEGER' },
        },
        required: ['requirement_ids', 'prompt', 'answer_outline', 'difficulty'],
      },
    },
  },
  required: ['questions'],
} as const;

const FLASHCARDS_SCHEMA = {
  type: 'OBJECT',
  properties: {
    flashcards: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          front: { type: 'STRING' },
          back: { type: 'STRING' },
          requirement_ids: { type: 'ARRAY', items: { type: 'STRING' } },
        },
        required: ['front', 'back', 'requirement_ids'],
      },
    },
  },
  required: ['flashcards'],
} as const;

const BRIEF_SCHEMA = {
  type: 'OBJECT',
  properties: {
    summary: { type: 'STRING' },
    what_they_do: { type: 'STRING' },
  },
  required: ['summary', 'what_they_do'],
} as const;

const llmQuestionsSchema = z.object({
  questions: z
    .array(
      z.object({
        requirement_ids: z.array(z.union([z.string(), z.number()])).catch([]),
        prompt: z.string().catch(''),
        answer_outline: z.string().catch(''),
        difficulty: z.union([z.number(), z.string()]).catch(2),
      }),
    )
    .catch([]),
});

const llmFlashcardsSchema = z.object({
  flashcards: z
    .array(
      z.object({
        front: z.string().catch(''),
        back: z.string().catch(''),
        requirement_ids: z.array(z.union([z.string(), z.number()])).catch([]),
      }),
    )
    .catch([]),
});

const llmBriefSchema = z.object({
  summary: z.string().catch(''),
  what_they_do: z.string().catch(''),
});

function clampDifficulty(raw: unknown): 1 | 2 | 3 {
  const n = Math.round(Number(raw));
  if (!Number.isFinite(n)) return 2;
  return Math.min(3, Math.max(1, n)) as 1 | 2 | 3;
}

function toIdList(raw: unknown[]): string[] {
  return raw.map((v) => String(v).trim()).filter(Boolean);
}

/**
 * Code-side validation of generated questions: keep only questions whose
 * requirement references exist (a question whose references ALL dangle is
 * dropped), force the requested category, clamp difficulty, drop duplicates.
 */
export function normalizeQuestions(
  raw: unknown,
  category: QuestionCategory,
  validRequirementIds: Set<string>,
  max = 12,
): RawQuestion[] {
  const parsed = llmQuestionsSchema.parse(raw ?? {});
  const out: RawQuestion[] = [];
  const seenPrompts = new Set<string>();
  for (const q of parsed.questions) {
    const prompt = q.prompt.trim().slice(0, 700);
    if (prompt.length < 10) continue;
    const dedupeKey = prompt.toLowerCase().replace(/\s+/g, ' ');
    if (seenPrompts.has(dedupeKey)) continue;
    const requested = toIdList(q.requirement_ids);
    const ids = requested.filter((id) => validRequirementIds.has(id)).slice(0, 3);
    if (requested.length > 0 && ids.length === 0) continue; // dangling references only
    seenPrompts.add(dedupeKey);
    out.push({
      requirement_ids: ids,
      category,
      prompt,
      answer_outline: q.answer_outline.trim().slice(0, 1_500),
      difficulty: clampDifficulty(q.difficulty),
    });
    if (out.length >= max) break;
  }
  return out;
}

export function normalizeFlashcards(raw: unknown, validRequirementIds: Set<string>, max = 24): RawFlashcard[] {
  const parsed = llmFlashcardsSchema.parse(raw ?? {});
  const out: RawFlashcard[] = [];
  const seenFronts = new Set<string>();
  for (const f of parsed.flashcards) {
    const front = f.front.trim().slice(0, 300);
    const back = f.back.trim().slice(0, 800);
    if (front.length < 5 || back.length < 1) continue;
    const key = front.toLowerCase().replace(/\s+/g, ' ');
    if (seenFronts.has(key)) continue;
    const requested = toIdList(f.requirement_ids);
    const ids = requested.filter((id) => validRequirementIds.has(id)).slice(0, 3);
    if (requested.length > 0 && ids.length === 0) continue;
    seenFronts.add(key);
    out.push({ front, back, requirement_ids: ids });
    if (out.length >= max) break;
  }
  return out;
}

function requirementListBlock(requirements: Requirement[]): string {
  return requirements.map((r) => `- ${r.id} [${r.priority}/${r.kind}]: ${r.text}`).join('\n');
}

// ---------------------------------------------------------------------------
// Company brief
// ---------------------------------------------------------------------------

const BRIEF_PAGES_LIMIT = 6;
const BRIEF_PAGE_CHARS = 3_000;

function honestEmptyBrief(company: string, reason: string): CompanyBrief {
  return {
    summary:
      `No usable research about ${company} could be retrieved (${reason}). ` +
      'Rather than guessing, this brief says so: prepare from the job description and your own research.',
    what_they_do: `Unknown - no pages about ${company} could be retrieved to describe what they do.`,
    sources: [],
  };
}

export interface BriefContext {
  company: string;
  roleTitle: string;
}

/**
 * Company brief strictly grounded in the crawled pages + discussion actually
 * found. Thin research yields an honest "could not find" brief, never a
 * fabricated one.
 */
export async function companyBrief(
  llm: LlmClient,
  crawl: CrawlResult,
  discussion: DiscussionResult,
  ctx: BriefContext,
): Promise<{ brief: CompanyBrief; warnings: Warning[] }> {
  const warnings: Warning[] = [];

  if (crawl.pages.length === 0 && discussion.items.length === 0) {
    return {
      brief: honestEmptyBrief(ctx.company, 'site crawl and discussion search both came up empty'),
      warnings: [
        {
          code: 'NO_COMPANY_RESEARCH',
          message: `no pages or public discussion could be retrieved for "${ctx.company}"; brief reports the gap honestly`,
        },
      ],
    };
  }

  // Prioritise hiring pages (most interview-relevant), then other pages.
  const chosen = [...crawl.hiringPages, ...crawl.infoPages].slice(0, BRIEF_PAGES_LIMIT);
  const pageBlocks = chosen
    .map((p) => dataBlock(`page ${p.url}`, capForPrompt(p.text, BRIEF_PAGE_CHARS)))
    .join('\n\n');
  const discussionBlock =
    discussion.items.length > 0
      ? dataBlock(
          'public discussion titles',
          discussion.items.map((d) => `- [${d.source}] ${d.title}`).join('\n'),
        )
      : '';

  const prompt =
    `Write a factual company brief for "${ctx.company}" to help a candidate prepare for a "${ctx.roleTitle}" interview.\n` +
    `${UNTRUSTED_DATA_RULE}\n\n` +
    'Rules:\n' +
    '- Use ONLY facts present in the provided pages and discussion titles. NEVER invent products, numbers, history or values.\n' +
    '- summary: 3-5 sentences on the company, culture and anything known about how they hire.\n' +
    '- what_they_do: 1-3 sentences describing the product/business as the pages describe it.\n' +
    '- If the provided material is thin or says nothing about something, SAY that plainly instead of guessing.\n\n' +
    (pageBlocks ? `${pageBlocks}\n\n` : '') +
    (discussionBlock ? `${discussionBlock}\n\n` : '') +
    'Return the JSON object only.';

  try {
    const raw = await llm.generateJson<unknown>('company brief', prompt, {
      system: 'You are a careful research assistant who never fabricates. You summarise only what the supplied evidence states.',
      temperature: 0.2,
      responseSchema: BRIEF_SCHEMA,
    });
    const parsed = llmBriefSchema.parse(raw ?? {});
    const summary = parsed.summary.trim();
    const whatTheyDo = parsed.what_they_do.trim();
    if (!summary || !whatTheyDo) throw new Error('model returned empty brief fields');
    return {
      brief: {
        summary: summary.slice(0, 2_000),
        what_they_do: whatTheyDo.slice(0, 1_200),
        // sources = the top page URLs actually fed into this call
        sources: chosen.map((p) => p.url).slice(0, BRIEF_PAGES_LIMIT),
      },
      warnings,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    warnings.push({ code: 'BRIEF_FAILED', message: `company brief generation failed: ${message}` });
    return { brief: honestEmptyBrief(ctx.company, 'brief generation failed'), warnings };
  }
}

// ---------------------------------------------------------------------------
// Questions - one separate call per category, different instructions each
// ---------------------------------------------------------------------------

export interface QuestionGenContext {
  requirements: Requirement[];
  roleTitle: string;
  seniority?: string;
  companyName?: string;
  /** Text from careers/hiring pages actually found (shapes company-fit heavily). */
  hiringEvidence?: string;
  /** Brief summary, used as company context when no hiring evidence exists. */
  briefSummary?: string;
  responsibilities?: string[];
}

const CATEGORY_INSTRUCTIONS: Record<QuestionCategory, string> = {
  technical:
    'Drill the TECHNICAL requirements the way a senior engineer interviewer would. Write concrete questions that ' +
    'probe depth: implementation details, trade-offs between options, debugging and failure modes, and scaling. ' +
    'Ground every question in the wording of the requirements; cover as many of the listed technical/domain ' +
    'requirement ids as possible, at least one question each where feasible.',
  behavioural:
    'Target the BEHAVIOURAL and interpersonal side of the role: mentoring junior engineers, communication with ' +
    'stakeholders, leading projects, handling disagreement, ownership. Ask for concrete past-experience answers ' +
    '(situation, action, result). Prefer explicit behavioural requirements; when there are none, ground questions ' +
    'in the listed responsibilities instead and reference the closest requirement ids.',
  'system-design':
    'Write SYSTEM DESIGN questions scoped to this role\'s stack and domain: architecture trade-offs, data modelling, ' +
    'API design, scaling and failure handling. Each question must reference the technical/domain requirement ids it ' +
    'exercises. Ask the candidate to design something realistic for this company\'s product area.',
  'company-fit':
    'Prepare the candidate for THIS company\'s process and motivation round. Use the hiring evidence: if the company ' +
    'publishes a take-home exercise followed by a system design round, the questions must address preparing for ' +
    'exactly that; if nothing is published, say so in spirit by focusing on standard company-fit themes grounded in ' +
    'the requirements and company material.',
};

export async function questionsForCategory(
  llm: LlmClient,
  category: QuestionCategory,
  ctx: QuestionGenContext,
): Promise<RawQuestion[]> {
  const validIds = new Set(ctx.requirements.map((r) => r.id));
  if (validIds.size === 0) return [];

  const relevant =
    category === 'behavioural'
      ? ctx.requirements.filter((r) => r.kind === 'behavioural' || r.priority === 'must')
      : category === 'system-design'
        ? ctx.requirements.filter((r) => r.kind === 'technical' || r.kind === 'domain')
        : ctx.requirements;
  if (relevant.length === 0 && category !== 'company-fit') return [];

  const evidence = (ctx.hiringEvidence ?? '').trim();
  const evidenceBlock = evidence
    ? dataBlock('hiring evidence from the company site', capForPrompt(evidence, 4_000))
    : 'Nothing about a hiring process was published or found on the site.';
  const responsibilitiesBlock =
    ctx.responsibilities && ctx.responsibilities.length > 0
      ? dataBlock('role responsibilities', ctx.responsibilities.join('\n').slice(0, 1_500))
      : '';

  const prompt =
    `Generate interview preparation questions for a "${ctx.roleTitle}"${ctx.seniority ? ` (${ctx.seniority})` : ''}` +
    `${ctx.companyName ? ` candidate at ${ctx.companyName}` : ''}, category: "${category}".\n` +
    `${UNTRUSTED_DATA_RULE}\n\n` +
    `Instructions for this category: ${CATEGORY_INSTRUCTIONS[category]}\n\n` +
    `Requirements (reference 1-3 of these ids per question, ids must come from this list):\n` +
    `${requirementListBlock(ctx.requirements)}\n\n` +
    (category === 'company-fit' || category === 'behavioural' ? `${evidenceBlock}\n\n` : '') +
    (ctx.briefSummary ? dataBlock('company brief summary', capForPrompt(ctx.briefSummary, 1_500)) + '\n\n' : '') +
    (responsibilitiesBlock ? `${responsibilitiesBlock}\n\n` : '') +
    'Each question needs: a specific prompt (max ~400 chars), an answer_outline of 3-6 concise guidance points, ' +
    'difficulty 1-3 (3 = hardest). Produce 4-8 questions. Return the JSON object only.';

  const raw = await llm.generateJson<unknown>(`questions:${category}`, prompt, {
    system:
      'You are an interview coach. You write specific, checkable preparation questions grounded strictly in the ' +
      'supplied requirements and evidence. You never fabricate requirement ids.',
    temperature: 0.4,
    responseSchema: QUESTIONS_SCHEMA,
  });

  return normalizeQuestions(raw, category, validIds);
}

// ---------------------------------------------------------------------------
// Gap pass - targeted generation ONLY for uncovered requirements
// ---------------------------------------------------------------------------

/**
 * Attempt 2+ escalates: the model failed to cover these requirements once, so
 * the phrasing changes (more prescriptive, anchored in the exact wording).
 */
export async function gapQuestions(
  llm: LlmClient,
  uncovered: Requirement[],
  attempt: number,
  ctx: Pick<QuestionGenContext, 'roleTitle' | 'companyName'>,
): Promise<RawQuestion[]> {
  if (uncovered.length === 0) return [];
  const validIds = new Set(uncovered.map((r) => r.id));

  const escalation =
    attempt >= 2
      ? 'A PREVIOUS generation pass already failed to cover these exact requirements. Change your approach: ' +
        'anchor each question in the requirement\'s exact wording, make each question unmistakably about that ' +
        'requirement, and reference its id. Do NOT repeat generic phrasing.'
      : 'These requirements currently have NO question against them.';

  const perReqCategory = uncovered
    .map((r) => `- ${r.id} [${r.priority}/${r.kind}] target category "${categoryHint(r.kind)}": ${r.text}`)
    .join('\n');

  const prompt =
    `Coverage check found gaps for a "${ctx.roleTitle}"${ctx.companyName ? ` at ${ctx.companyName}` : ''}. ${escalation}\n` +
    `${UNTRUSTED_DATA_RULE}\n\n` +
    'Requirements with no questions yet - write AT LEAST ONE question per listed id, more if useful:\n' +
    `${perReqCategory}\n\n` +
    'Each question: requirement_ids MUST include the id it covers (1-3 ids), a specific prompt, an answer_outline ' +
    'of 3-6 guidance points, difficulty 1-3. Return the JSON object only.';

  const raw = await llm.generateJson<unknown>('questions:gap-fill', prompt, {
    system:
      'You close coverage gaps in an interview prep kit. Every requirement id you are given MUST appear in at ' +
      'least one question you return.',
    temperature: attempt >= 2 ? 0.6 : 0.4,
    responseSchema: QUESTIONS_SCHEMA,
  });

  const normalized = normalizeQuestions(raw, 'technical', validIds, 12);
  // The CATEGORY is assigned by code from the requirement kind, not the model.
  return normalized.map((q) => ({
    ...q,
    category: categoryForRefs(q.requirement_ids, uncovered),
  }));
}

function categoryHint(kind: Requirement['kind']): QuestionCategory {
  switch (kind) {
    case 'behavioural':
      return 'behavioural';
    case 'domain':
    case 'technical':
    default:
      return 'technical';
  }
}

function categoryForRefs(ids: string[], pool: Requirement[]): QuestionCategory {
  const byId = new Map(pool.map((r) => [r.id, r] as const));
  for (const id of ids) {
    const req = byId.get(id);
    if (req) return categoryHint(req.kind);
  }
  return 'technical';
}

// ---------------------------------------------------------------------------
// Flashcards
// ---------------------------------------------------------------------------

export async function flashcardsFor(
  llm: LlmClient,
  requirements: Requirement[],
  roleTitle: string,
): Promise<RawFlashcard[]> {
  const validIds = new Set(requirements.map((r) => r.id));
  if (validIds.size === 0) return [];

  const mustFirst = [...requirements].sort((a, b) =>
    a.priority === b.priority ? 0 : a.priority === 'must' ? -1 : 1,
  );

  const prompt =
    `Create study flashcards for the requirements of a "${roleTitle}" role.\n` +
    `${UNTRUSTED_DATA_RULE}\n\n` +
    'Requirements (must-haves first - prioritise them):\n' +
    `${requirementListBlock(mustFirst)}\n\n` +
    'Card rules: front is a sharp question or cue (max ~150 chars); back is the concise answer or checklist a ' +
    'candidate must recall (max ~350 chars); requirement_ids lists 1-3 ids the card drills. Cover as many ' +
    'must-have ids as possible. 8-16 cards. Return the JSON object only.';

  const raw = await llm.generateJson<unknown>('flashcards', prompt, {
    system: 'You write precise memorisation flashcards grounded only in the supplied requirements.',
    temperature: 0.3,
    responseSchema: FLASHCARDS_SCHEMA,
  });

  return normalizeFlashcards(raw, validIds);
}
