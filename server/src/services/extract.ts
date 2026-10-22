// Requirement extraction from the pasted job description: one LLM call in
// JSON-schema mode, then code-side validation, normalisation, id assignment
// (r1..rN) and jd_chars. The prompt forbids invention - a two-line JD must
// yield few or zero requirements, reported honestly.

import { z } from 'zod';
import { PipelineError } from '../core/ports';
import type { Requirement, RequirementKind, RequirementPriority } from '../core/types';
import type { LlmClient } from './gemini';
import { UNTRUSTED_DATA_RULE, capForPrompt, dataBlock } from './prompt';

export interface ExtractedRole {
  title: string;
  seniority: string;
  location: string;
  responsibilities: string[];
  requirements: Requirement[];
  jdChars: number;
}

const MAX_REQUIREMENTS = 40;
const MAX_RESPONSIBILITIES = 20;

const llmExtractionSchema = z.object({
  title: z.string().catch(''),
  seniority: z.string().catch(''),
  location: z.string().catch(''),
  responsibilities: z.array(z.string()).catch([]),
  requirements: z
    .array(
      z.object({
        text: z.string(),
        kind: z.union([z.string(), z.number(), z.null(), z.undefined()]).catch(null),
        priority: z.union([z.string(), z.number(), z.null(), z.undefined()]).catch(null),
      }),
    )
    .catch([]),
});

function normalizeKind(raw: unknown): RequirementKind | null {
  const v = String(raw ?? '').trim().toLowerCase();
  if (['technical', 'tech', 'hard skill', 'hard-skill'].includes(v)) return 'technical';
  if (['behavioural', 'behavioral', 'behaviour', 'behavior', 'soft skill', 'soft-skill', 'soft'].includes(v)) {
    return 'behavioural';
  }
  if (['domain', 'business', 'industry'].includes(v)) return 'domain';
  return null;
}

function normalizePriority(raw: unknown): RequirementPriority | null {
  const v = String(raw ?? '').trim().toLowerCase();
  if (['must', 'required', 'requirement', 'mandatory', 'must-have', 'essential'].includes(v)) return 'must';
  if (['nice', 'nice-to-have', 'bonus', 'preferred', 'plus', 'optional', 'desirable'].includes(v)) return 'nice';
  return null;
}

/** Code-side seniority fallback when the model returned nothing useful. */
export function guessSeniority(text: string, fallback: string): string {
  const t = text.toLowerCase();
  if (/\b(staff|principal)\b/.test(t)) return 'staff';
  if (/\blead\b|\btech lead\b|\bteam lead\b/.test(t)) return 'lead';
  if (/\bsenior\b|\bsr\.?\b/.test(t)) return 'senior';
  if (/\bjunior\b|\bentry[- ]level\b|\bgraduate\b/.test(t)) return 'junior';
  if (/\bmid\b|\bintermediate\b/.test(t)) return 'mid';
  return fallback || 'not stated';
}

const EXTRACTION_SYSTEM =
  'You are a precise job-description analyst. You extract ONLY what is explicitly present in the ' +
  'supplied job description text. You never invent, infer, or pad: if the description is thin, you ' +
  'return few or zero requirements - that is correct behaviour, not a failure.';

const EXTRACTION_SCHEMA = {
  type: 'OBJECT',
  properties: {
    title: { type: 'STRING' },
    seniority: { type: 'STRING' },
    location: { type: 'STRING' },
    responsibilities: { type: 'ARRAY', items: { type: 'STRING' } },
    requirements: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          text: { type: 'STRING' },
          kind: { type: 'STRING', enum: ['technical', 'behavioural', 'domain'] },
          priority: { type: 'STRING', enum: ['must', 'nice'] },
        },
        required: ['text', 'kind', 'priority'],
      },
    },
  },
  required: ['title', 'seniority', 'location', 'responsibilities', 'requirements'],
} as const;

/** Extract role fields and requirements from the JD. Throws EXTRACT_FAILED on empty input. */
export async function extractRole(llm: LlmClient, jd: string): Promise<ExtractedRole> {
  const trimmedJd = jd.trim();
  if (!trimmedJd) {
    throw new PipelineError('EXTRACT_FAILED', 'job description is empty');
  }
  const jdChars = jd.length;

  const prompt =
    'Extract the structured facts of the job posting below.\n' +
    `${UNTRUSTED_DATA_RULE}\n\n` +
    'Rules:\n' +
    '- Requirements come ONLY from the posting text. Do NOT invent, guess, or add skills the text does not mention.\n' +
    '- priority "must": the posting words it as required, mandatory, or a plain requirement ("You have 5+ years of React").\n' +
    '- priority "nice": "bonus points", "nice to have", "preferred", "plus", "ideally", "a bonus".\n' +
    '- kind: "technical" for languages, frameworks, infrastructure, tools, testing; "behavioural" for mentoring, ' +
    'communication, collaboration, leadership, ownership; "domain" for industry/business-domain knowledge (payments, healthcare, ...).\n' +
    '- A short or vague posting produces FEW or ZERO requirements. Never pad to a quota.\n' +
    '- title: the posted role title, or "" if none. seniority: junior/mid/senior/lead/staff as stated or implied, or "".\n' +
    '- location: as stated, or "". responsibilities: short phrases from the posting (may be empty).\n' +
    '- Requirement texts are short noun phrases in the posting\'s own words (not full sentences).\n\n' +
    dataBlock('job description', capForPrompt(jd, 20_000)) +
    '\n\nReturn the JSON object only.';

  const raw = await llm.generateJson<unknown>('role extraction', prompt, {
    system: EXTRACTION_SYSTEM,
    temperature: 0.2,
    responseSchema: EXTRACTION_SCHEMA,
  });

  const parsed = llmExtractionSchema.parse(raw ?? {});

  // Drop garbage requirement entries (empty text, unknown kind/priority), then dedupe.
  const seen = new Set<string>();
  const requirements: Requirement[] = [];
  for (const entry of parsed.requirements) {
    const text = String(entry?.text ?? '').trim().slice(0, 500);
    if (text.length < 3) continue;
    const kind = normalizeKind(entry?.kind);
    const priority = normalizePriority(entry?.priority);
    if (!kind || !priority) continue;
    const dedupeKey = `${priority}:${kind}:${text.toLowerCase()}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    requirements.push({ id: '', text, kind, priority });
    if (requirements.length >= MAX_REQUIREMENTS) break;
  }
  // Stable ids are assigned by THIS code, never the model.
  requirements.forEach((r, i) => {
    r.id = `r${i + 1}`;
  });

  const responsibilities = parsed.responsibilities
    .map((s) => String(s).trim().slice(0, 200))
    .filter((s) => s.length > 0)
    .slice(0, MAX_RESPONSIBILITIES);

  const title = parsed.title.trim().slice(0, 120);
  const seniority = guessSeniority(`${title}\n${trimmedJd.slice(0, 2_000)}`, parsed.seniority.trim().slice(0, 40));

  return {
    title,
    seniority,
    location: parsed.location.trim().slice(0, 120),
    responsibilities,
    requirements,
    jdChars,
  };
}
