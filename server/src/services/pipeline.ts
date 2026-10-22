// Pipeline orchestration - implements core/ports.ts KitGenerator. One module
// used identically by the HTTP app and the batch CLI.
//
// Stage order (progress + checkpoints): extract -> crawl -> discussion ->
// brief -> questions -> coverage -> flashcards -> schedule -> validate.
// Coverage and scheduling are deterministic CODE decisions; the model never
// allocates days nor judges its own coverage. Checkpoints let a resumed run
// skip completed stages.

import {
  computeCoverage,
  stripDanglingRefs,
  uncoveredRequirementIds,
} from '../core/coverage';
import type { KitGenerator, PipelineInput, RunContext, Section } from '../core/ports';
import { PipelineError } from '../core/ports';
import { repairScheduleAfterRegen, mergeRegeneratedQuestions, recomputeCoverageInPlace } from '../core/kitState';
import { kitSchema } from '../core/schemas';
import { nextId } from '../core/ids';
import { buildSchedule, recomputeSchedule } from '../core/schedule';
import type {
  CompanyBrief,
  KitDocument,
  Question,
  QuestionCategory,
  Requirement,
  Warning,
} from '../core/types';
import { crawlCompanySite } from './crawl';
import type { CrawlOptions, CrawlResult, HostResolver } from './crawl';
import { searchDiscussions } from './discussion';
import type { DiscussionResult } from './discussion';
import { extractRole } from './extract';
import type { ExtractedRole } from './extract';
import { createGeminiClient } from './gemini';
import type { LlmClient } from './gemini';
import { companyBrief, flashcardsFor, gapQuestions, questionsForCategory } from './generate';
import type { RawQuestion } from './generate';
import type { Fetcher, Sleep } from './http';
import { defaultSleep } from './http';

export const STAGES = [
  'extract',
  'crawl',
  'discussion',
  'brief',
  'questions',
  'coverage',
  'flashcards',
  'schedule',
  'validate',
] as const;

const MAX_COVERAGE_PASSES = 3; // initial + 2 gap passes
const QUESTION_CATEGORIES: QuestionCategory[] = ['technical', 'behavioural', 'system-design', 'company-fit'];

export interface PipelineDeps {
  llm?: LlmClient;
  fetcher?: Fetcher;
  resolveHost?: HostResolver;
  allowPrivate?: boolean;
  sleep?: Sleep;
  now?: () => Date;
  crawlMaxPages?: number;
}

function dedupeWarnings(warnings: Warning[]): Warning[] {
  const seen = new Set<string>();
  const out: Warning[] = [];
  for (const w of warnings) {
    const key = `${w.code}::${w.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ code: String(w.code), message: String(w.message) });
  }
  return out;
}

function hostnameOf(rawUrl: string): string {
  try {
    return new URL(rawUrl).hostname;
  } catch {
    return '';
  }
}

function hiringEvidenceOf(crawl: CrawlResult): string {
  return crawl.hiringPages
    .map((p) => `${p.url} :: ${p.text.slice(0, 1_500)}`)
    .join('\n\n')
    .slice(0, 6_000);
}

function thinExtractionWarnings(extraction: ExtractedRole): Warning[] {
  const warnings: Warning[] = [];
  if (extraction.requirements.length === 0) {
    warnings.push({
      code: 'THIN_JD',
      message:
        'The job description is too short to extract any concrete requirements, so this kit is intentionally thin rather than invented.',
    });
  } else if (extraction.requirements.length <= 2 && extraction.jdChars < 400) {
    warnings.push({
      code: 'THIN_JD',
      message: `The job description is short and yielded only ${extraction.requirements.length} requirements.`,
    });
  }
  return warnings;
}

function crawlGapWarnings(crawl: CrawlResult): Warning[] {
  const warnings: Warning[] = [];
  if (crawl.pages.length > 0 && crawl.hiringPages.length === 0) {
    warnings.push({
      code: 'NO_HIRING_PAGE',
      message:
        "The company website has no discoverable hiring or careers page, so company-fit questions use general themes instead of their specific process.",
    });
  }
  return warnings;
}

/** Build the real generator; tests inject fake {llm, fetcher, ...}. */
export function createKitGenerator(deps: PipelineDeps = {}): KitGenerator {
  const llm = deps.llm ?? createGeminiClient({ fetcher: deps.fetcher });
  const sleep = deps.sleep ?? defaultSleep;
  const now = deps.now ?? (() => new Date());
  const crawlOptions: CrawlOptions = {
    fetcher: deps.fetcher,
    resolveHost: deps.resolveHost,
    allowPrivate: deps.allowPrivate,
    sleep,
    maxPages: deps.crawlMaxPages,
  };

  async function stage<T>(name: string, ctx: RunContext, compute: () => Promise<T> | T): Promise<T> {
    const saved = await ctx.loadCheckpoint(name);
    if (saved !== null && saved !== undefined) return saved as T;
    const value = await compute();
    await ctx.saveCheckpoint(name, value);
    return value;
  }

  async function run(input: PipelineInput, ctx: RunContext): Promise<{ kit: KitDocument; warnings: Warning[] }> {
    if (!Number.isInteger(input.days) || input.days < 1 || input.days > 60) {
      throw new PipelineError('INVALID_INPUT', `days must be an integer between 1 and 60, got ${input.days}`);
    }

    // --- extract -------------------------------------------------------------
    const extraction = await stage('extract', ctx, async () => {
      await ctx.onProgress('extract', 'Extracting role and requirements from the job description');
      return extractRole(llm, input.jd);
    });
    const requirements: Requirement[] = extraction.requirements;
    const roleTitle = extraction.title || 'this role';

    // --- crawl ---------------------------------------------------------------
    const crawl = await stage('crawl', ctx, async () => {
      await ctx.onProgress('crawl', `Crawling ${input.companyUrl} (ranked link discovery, robots-aware)`);
      return crawlCompanySite(input.companyUrl, crawlOptions);
    });
    const company = crawl.company || hostnameOf(input.companyUrl) || 'Unknown company';

    // --- discussion ----------------------------------------------------------
    const discussion: DiscussionResult = await stage('discussion', ctx, async () => {
      await ctx.onProgress('discussion', `Searching public discussion about ${company} interviews`);
      return searchDiscussions(company, { fetcher: deps.fetcher, sleep });
    });

    // --- brief ---------------------------------------------------------------
    const briefStage = await stage('brief', ctx, async () => {
      await ctx.onProgress('brief', 'Writing the company brief from the pages actually found');
      return companyBrief(llm, crawl, discussion, { company, roleTitle });
    });
    const brief: CompanyBrief = briefStage.brief;

    // --- questions (one SEPARATE call per category) ---------------------------
    const questions: Question[] = await stage('questions', ctx, async () => {
      const out: Question[] = [];
      const usedIds: string[] = [];
      const hasTechnical = requirements.some((r) => r.kind === 'technical' || r.kind === 'domain');
      for (const category of QUESTION_CATEGORIES) {
        if (category === 'system-design' && !hasTechnical) continue;
        await ctx.onProgress('questions', `Generating ${category} questions`);
        const raw = await questionsForCategory(llm, category, {
          requirements,
          roleTitle,
          seniority: extraction.seniority,
          companyName: company,
          hiringEvidence: hiringEvidenceOf(crawl),
          briefSummary: brief.summary,
          responsibilities: extraction.responsibilities,
        });
        for (const rq of raw) {
          const id = nextId('q', usedIds);
          usedIds.push(id);
          out.push({
            id,
            requirement_ids: rq.requirement_ids,
            category: rq.category,
            prompt: rq.prompt,
            answer_outline: rq.answer_outline,
            difficulty: rq.difficulty,
            origin: 'generated',
            item_state: 'pristine',
            pinned: false,
          });
        }
      }
      return out;
    });

    // --- coverage loop (deterministic, in code) -------------------------------
    // NOTE: core stripDanglingRefs REPLACES the questions array, so all
    // mutation below happens through the `working` object, never a stale copy.
    const coverageStage = await stage('coverage', ctx, async () => {
      await ctx.onProgress('coverage', 'Checking question coverage against the extracted requirements');
      const working = {
        questions: [...questions],
        flashcards: [],
        role: { requirements },
      } as unknown as Parameters<typeof stripDanglingRefs>[0];
      stripDanglingRefs(working);
      let passes = 1;
      let uncovered = uncoveredRequirementIds(working, 'must');

      while (uncovered.length > 0 && passes < MAX_COVERAGE_PASSES) {
        const attempt = passes + 1; // gap pass number (initial generation was attempt 1)
        const gapReqs = requirements.filter((r) => uncovered.includes(r.id));
        await ctx.onProgress(
          'coverage',
          `Pass ${attempt}: generating questions for uncovered must-haves (${gapReqs.map((r) => r.id).join(', ')})`,
        );
        const rawGap: RawQuestion[] = await gapQuestions(llm, gapReqs, attempt, { roleTitle, companyName: company });
        const usedIds = working.questions.map((q) => q.id);
        for (const rq of rawGap) {
          const id = nextId('q', usedIds);
          usedIds.push(id);
          working.questions.push({
            id,
            requirement_ids: rq.requirement_ids,
            category: rq.category,
            prompt: rq.prompt,
            answer_outline: rq.answer_outline,
            difficulty: rq.difficulty,
            origin: 'generated',
            item_state: 'pristine',
            pinned: false,
          });
        }
        stripDanglingRefs(working);
        uncovered = uncoveredRequirementIds(working, 'must');
        passes++;
      }

      if (uncovered.length > 0) {
        throw new PipelineError(
          'COVERAGE_INCOMPLETE',
          `must-have requirements still without questions after ${passes} passes: ${uncovered.join(', ')}`,
        );
      }
      return {
        questions: working.questions,
        coverage: computeCoverage(working, passes),
      };
    });
    const finalQuestions: Question[] = coverageStage.questions;
    const coverage = coverageStage.coverage;

    // --- flashcards ------------------------------------------------------------
    const flashcards = await stage('flashcards', ctx, async () => {
      await ctx.onProgress('flashcards', 'Creating flashcards from the final requirement set');
      const raw = await flashcardsFor(llm, requirements, roleTitle);
      const usedIds: string[] = [];
      return raw.map((f) => {
        const id = nextId('f', usedIds);
        usedIds.push(id);
        return {
          id,
          front: f.front,
          back: f.back,
          requirement_ids: f.requirement_ids,
          origin: 'generated' as const,
          item_state: 'pristine' as const,
          pinned: false,
        };
      });
    });

    // --- schedule (deterministic, in code) --------------------------------------
    const schedule = await stage('schedule', ctx, async () => {
      await ctx.onProgress('schedule', `Allocating the material across exactly ${input.days} day(s)`);
      return buildSchedule(finalQuestions, requirements, input.days);
    });

    // --- assemble + validate -----------------------------------------------------
    const niceGaps = uncoveredRequirementIds(
      { questions: finalQuestions, role: { requirements } } as Parameters<typeof uncoveredRequirementIds>[0],
      'nice',
    );
    const warnings = dedupeWarnings([
      ...crawl.warnings,
      ...discussion.warnings,
      ...briefStage.warnings,
      ...thinExtractionWarnings(extraction),
      ...crawlGapWarnings(crawl),
      ...(niceGaps.length > 0
        ? [
            {
              code: 'NICE_REQUIREMENTS_UNCOVERED',
              message: `nice-to-have requirements with no dedicated question (reported, not fatal): ${niceGaps.join(', ')}`,
            },
          ]
        : []),
    ]);

    let kit: KitDocument = {
      source: {
        company,
        company_url: input.companyUrl,
        role: extraction.title || 'Unknown role',
        location: extraction.location,
        jd_chars: extraction.jdChars,
        researched_at: now().toISOString(),
        pages_used: crawl.pages.map((p) => p.url).slice(0, 15),
      },
      company_brief: brief,
      role: {
        title: extraction.title,
        seniority: extraction.seniority,
        responsibilities: extraction.responsibilities,
        requirements,
      },
      questions: finalQuestions,
      flashcards,
      schedule,
      coverage,
      warnings,
    };

    await ctx.onProgress('validate', 'Validating the kit against the Appendix A structure');
    let validated = kitSchema.safeParse(kit);
    if (!validated.success) {
      await ctx.onProgress('validate', 'Kit invalid - attempting one repair pass');
      kit = await repairKitWithLlm(llm, kit, validated.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`));
      validated = kitSchema.safeParse(kit);
      if (!validated.success) {
        throw new PipelineError(
          'KIT_INVALID',
          `kit failed Appendix A validation: ${validated.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
        );
      }
    }
    await ctx.saveCheckpoint('validate', { ok: true });

    return { kit: validated.data as KitDocument, warnings: kit.warnings };
  }

  async function regenerate(
    kit: KitDocument,
    section: Section,
    opts: { days?: number },
    ctx: RunContext,
  ): Promise<{ kit: KitDocument; warnings: Warning[] }> {
    if (section === 'brief') {
      await ctx.onProgress('brief', 'Re-researching the company site and public discussion');
      const crawl = await crawlCompanySite(kit.source.company_url, crawlOptions);
      const discussion = await searchDiscussions(kit.source.company, { fetcher: deps.fetcher, sleep });
      await ctx.onProgress('brief', 'Rewriting the company brief from fresh research');
      const { brief, warnings } = await companyBrief(llm, crawl, discussion, {
        company: kit.source.company,
        roleTitle: kit.source.role,
      });
      kit.company_brief = brief;
      if (crawl.pages.length > 0) {
        kit.source.pages_used = crawl.pages.map((p) => p.url).slice(0, 15);
      }
      kit.warnings = dedupeWarnings([...kit.warnings, ...warnings]);
      return { kit, warnings };
    }

    if (section === 'schedule') {
      const days = opts.days ?? kit.schedule.days_available;
      if (!Number.isInteger(days) || days < 1 || days > 60) {
        throw new PipelineError('INVALID_INPUT', `days must be an integer between 1 and 60, got ${days}`);
      }
      await ctx.onProgress('schedule', `Recomputing the schedule across ${days} day(s)`);
      kit.schedule.days_available = days;
      recomputeSchedule(kit);
      recomputeCoverageInPlace(kit);
      return { kit, warnings: [] };
    }

    // Question category regeneration: pristine generated items of THIS category
    // are replaced; manual/edited/pinned items and every other section survive.
    const category = section as QuestionCategory;
    await ctx.onProgress(section, `Regenerating ${category} questions`);
    const removedIds = kit.questions
      .filter((q) => q.category === category && q.origin === 'generated' && q.item_state === 'pristine' && !q.pinned)
      .map((q) => q.id);
    const raw = await questionsForCategory(llm, category, {
      requirements: kit.role.requirements,
      roleTitle: kit.source.role,
      seniority: kit.role.seniority,
      companyName: kit.source.company,
      briefSummary: kit.company_brief.summary,
      responsibilities: kit.role.responsibilities,
    });
    const incoming: Question[] = raw.map((q) => ({
      ...q,
      id: 'pending',
      origin: 'generated',
      item_state: 'pristine',
      pinned: false,
    }));
    const before = new Set(kit.questions.map((q) => q.id));
    kit.questions = mergeRegeneratedQuestions(kit, category, incoming);
    const addedIds = kit.questions.filter((q) => !before.has(q.id)).map((q) => q.id);
    repairScheduleAfterRegen(kit, removedIds, addedIds);
    return { kit, warnings: [] };
  }

  return { run, regenerate };
}

/** One LLM repair attempt for a kit that failed Appendix A validation. */
async function repairKitWithLlm(llm: LlmClient, kit: KitDocument, issues: string[]): Promise<KitDocument> {
  try {
    const repaired = await llm.generateJson<unknown>('kit repair', (
      'The following generated kit failed schema validation. Fix ONLY the listed problems, keep every other field ' +
      'exactly as it is, keep all ids stable, and return the complete corrected kit JSON.\n\n' +
      `Validation issues:\n${issues.map((i) => `- ${i}`).join('\n')}\n\n` +
      'Kit to fix:\n' +
      JSON.stringify(kit)
    ), { temperature: 0 });
    if (repaired && typeof repaired === 'object') {
      const candidate = repaired as KitDocument;
      // Never let a repair drop or rename the deterministic sections.
      return {
        ...candidate,
        schedule: kit.schedule,
        coverage: kit.coverage,
        questions: kit.questions,
        flashcards: kit.flashcards,
        warnings: candidate.warnings ?? kit.warnings,
      };
    }
  } catch {
    // repair is best-effort; caller decides on KIT_INVALID
  }
  return kit;
}
