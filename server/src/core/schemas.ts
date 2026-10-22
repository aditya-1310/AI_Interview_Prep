import { z } from 'zod';

// Appendix A field names are exact; .strict() catches camelCase drift and typos
// on output kits. Input schemas stay lenient (.strip) so unexpected fields in
// grader-provided files never break a run.

export const requirementKindSchema = z.enum(['technical', 'behavioural', 'domain']);
export const requirementPrioritySchema = z.enum(['must', 'nice']);
export const questionCategorySchema = z.enum(['technical', 'behavioural', 'system-design', 'company-fit']);
export const itemOriginSchema = z.enum(['generated', 'manual']);
export const itemStateSchema = z.enum(['pristine', 'edited']);

export const requirementSchema = z
  .object({
    id: z.string().min(1),
    text: z.string().min(1),
    kind: requirementKindSchema,
    priority: requirementPrioritySchema,
  })
  .strict();

export const roleSchema = z
  .object({
    title: z.string(),
    seniority: z.string(),
    responsibilities: z.array(z.string()),
    requirements: z.array(requirementSchema),
  })
  .strict();

export const sourceInfoSchema = z
  .object({
    company: z.string(),
    company_url: z.string(),
    role: z.string(),
    location: z.string(),
    jd_chars: z.number().int().min(0),
    researched_at: z.string().min(1),
    pages_used: z.array(z.string()),
  })
  .strict();

export const companyBriefSchema = z
  .object({
    summary: z.string(),
    what_they_do: z.string(),
    sources: z.array(z.string()),
  })
  .strict();

export const questionSchema = z
  .object({
    id: z.string().min(1),
    requirement_ids: z.array(z.string()),
    category: questionCategorySchema,
    prompt: z.string().min(1),
    answer_outline: z.string(),
    difficulty: z.number().int().min(1).max(3),
    origin: itemOriginSchema,
    item_state: itemStateSchema,
    pinned: z.boolean(),
  })
  .strict();

export const flashcardSchema = z
  .object({
    id: z.string().min(1),
    front: z.string().min(1),
    back: z.string().min(1),
    requirement_ids: z.array(z.string()),
    origin: itemOriginSchema,
    item_state: itemStateSchema,
    pinned: z.boolean(),
  })
  .strict();

export const scheduleDaySchema = z
  .object({
    day: z.number().int().min(1),
    focus: z.string().min(1),
    question_ids: z.array(z.string()),
    minutes: z.number().int().min(0),
  })
  .strict();

export const scheduleSchema = z
  .object({
    days_available: z.number().int().min(1),
    days: z.array(scheduleDaySchema).min(1),
  })
  .strict();

export const coverageSchema = z
  .object({
    uncovered_requirement_ids: z.array(z.string()),
    passes: z.number().int().min(1),
  })
  .strict();

export const warningSchema = z
  .object({
    code: z.string().min(1),
    message: z.string().min(1),
  })
  .strict();

export const kitSchema = z
  .object({
    source: sourceInfoSchema,
    company_brief: companyBriefSchema,
    role: roleSchema,
    questions: z.array(questionSchema),
    flashcards: z.array(flashcardSchema),
    schedule: scheduleSchema,
    coverage: coverageSchema,
    warnings: z.array(warningSchema),
  })
  .strict();

// Appendix B

export const batchCaseInputSchema = z.object({
  id: z.string().min(1),
  jd: z.string().min(1),
  company_url: z.string(),
  days: z.number().int().min(1).max(60),
});

export const batchOutputSchema = z.object({
  version: z.literal('1.0'),
  generated_at: z.string().min(1),
  kits: z.array(
    z.object({
      id: z.string().min(1),
      status: z.enum(['ok', 'failed']),
      kit: kitSchema.nullable(),
      error: z
        .object({
          code: z.string().min(1),
          message: z.string().min(1),
        })
        .nullable(),
    }),
  ),
});

// API request shapes

export const createKitInputSchema = z.object({
  jd: z.string().min(1).max(100_000),
  companyUrl: z.string().min(1).max(2000),
  days: z.number().int().min(1).max(60),
});

export const batchCreateInputSchema = z.object({
  cases: z.array(createKitInputSchema).min(1).max(25),
});

export const regenerateInputSchema = z.object({
  section: z.enum(['brief', 'technical', 'behavioural', 'system-design', 'company-fit', 'schedule']),
  days: z.number().int().min(1).max(60).optional(),
  baseVersion: z.number().int().min(1).optional(),
});

export const questionPatchSchema = z.object({
  category: questionCategorySchema.optional(),
  prompt: z.string().min(1).optional(),
  answer_outline: z.string().optional(),
  difficulty: z.number().int().min(1).max(3).optional(),
  requirement_ids: z.array(z.string()).optional(),
  baseVersion: z.number().int().min(1).optional(),
});

export const newManualQuestionSchema = z.object({
  category: questionCategorySchema,
  prompt: z.string().min(1),
  answer_outline: z.string().default(''),
  difficulty: z.number().int().min(1).max(3),
  requirement_ids: z.array(z.string()).default([]),
});

export const flashcardPatchSchema = z.object({
  front: z.string().min(1).optional(),
  back: z.string().min(1).optional(),
  requirement_ids: z.array(z.string()).optional(),
  baseVersion: z.number().int().min(1).optional(),
});

export const newManualFlashcardSchema = z.object({
  front: z.string().min(1),
  back: z.string().min(1),
  requirement_ids: z.array(z.string()).default([]),
});

export const confidenceSchema = z.object({
  level: z.union([z.literal(1), z.literal(2), z.literal(3)]),
});

export const reorderSchema = z.object({
  orderedIds: z.array(z.string()).min(1),
  baseVersion: z.number().int().min(1).optional(),
});

export const briefPatchSchema = z.object({
  summary: z.string().optional(),
  what_they_do: z.string().optional(),
  baseVersion: z.number().int().min(1).optional(),
});

export const schedulePatchSchema = z.object({
  days: z.array(scheduleDaySchema).min(1),
  baseVersion: z.number().int().min(1).optional(),
});

export type CreateKitInput = z.infer<typeof createKitInputSchema>;
export type NewManualQuestion = z.infer<typeof newManualQuestionSchema>;
export type NewManualFlashcard = z.infer<typeof newManualFlashcardSchema>;
