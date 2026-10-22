// Kit contracts mirroring Appendix A of the assignment exactly, plus the
// builder metadata that extends it (origin / item_state / pinned, warnings).

export type RequirementKind = 'technical' | 'behavioural' | 'domain';
export type RequirementPriority = 'must' | 'nice';
export type QuestionCategory = 'technical' | 'behavioural' | 'system-design' | 'company-fit';
export type ItemOrigin = 'generated' | 'manual';
export type ItemState = 'pristine' | 'edited';

export interface Requirement {
  id: string;
  text: string;
  kind: RequirementKind;
  priority: RequirementPriority;
}

export interface Role {
  title: string;
  seniority: string;
  responsibilities: string[];
  requirements: Requirement[];
}

export interface SourceInfo {
  company: string;
  company_url: string;
  role: string;
  location: string;
  jd_chars: number;
  researched_at: string;
  pages_used: string[];
}

export interface CompanyBrief {
  summary: string;
  what_they_do: string;
  sources: string[];
}

export interface Question {
  id: string;
  requirement_ids: string[];
  category: QuestionCategory;
  prompt: string;
  answer_outline: string;
  difficulty: 1 | 2 | 3;
  origin: ItemOrigin;
  item_state: ItemState;
  pinned: boolean;
}

export interface Flashcard {
  id: string;
  front: string;
  back: string;
  requirement_ids: string[];
  origin: ItemOrigin;
  item_state: ItemState;
  pinned: boolean;
}

export interface ScheduleDay {
  day: number;
  focus: string;
  question_ids: string[];
  minutes: number;
}

export interface Schedule {
  days_available: number;
  days: ScheduleDay[];
}

export interface Coverage {
  uncovered_requirement_ids: string[];
  passes: number;
}

export interface Warning {
  code: string;
  message: string;
}

/** The kit JSON as handed around and persisted - Appendix A plus extensions. */
export type KitDocument = Kit;

export interface Kit {
  source: SourceInfo;
  company_brief: CompanyBrief;
  role: Role;
  questions: Question[];
  flashcards: Flashcard[];
  schedule: Schedule;
  coverage: Coverage;
  warnings: Warning[];
}

/** The stored Mongo document wrapping a kit. */
export interface KitRecord {
  userId: string;
  status: 'pending' | 'ready' | 'failed';
  version: number;
  input: { jd: string; companyUrl: string; days: number; inputHash: string };
  kit: KitDocument;
  practice: Record<string, { confidence: 1 | 2 | 3; lastPracticedAt: string }>;
}

// Batch contracts (Appendix B)

export interface BatchCaseInput {
  id: string;
  jd: string;
  company_url: string;
  days: number;
}

export interface BatchKitResult {
  id: string;
  status: 'ok' | 'failed';
  kit: KitDocument | null;
  error: { code: string; message: string } | null;
}

export interface BatchOutput {
  version: '1.0';
  generated_at: string;
  kits: BatchKitResult[];
}

// Fields the builder accepts when a user creates items by hand

export interface NewManualQuestionFields {
  category: QuestionCategory;
  prompt: string;
  answer_outline: string;
  difficulty: 1 | 2 | 3;
  requirement_ids: string[];
}

export interface NewManualFlashcardFields {
  front: string;
  back: string;
  requirement_ids: string[];
}
