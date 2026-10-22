// Seams between the API layer and the generation pipeline. The API depends
// only on these interfaces; services/pipeline.ts implements them.

import type { KitDocument, Warning } from './types';

export type Section = 'brief' | 'technical' | 'behavioural' | 'system-design' | 'company-fit' | 'schedule';

export interface PipelineInput {
  jd: string;
  companyUrl: string;
  days: number;
}

export type ProgressFn = (step: string, message: string) => void | Promise<void>;

export interface RunContext {
  onProgress: ProgressFn;
  saveCheckpoint(stage: string, data: unknown): Promise<void>;
  loadCheckpoint(stage: string): Promise<unknown | null>;
}

export interface PipelineResult {
  kit: KitDocument;
  warnings: Warning[];
}

export interface KitGenerator {
  run(input: PipelineInput, ctx: RunContext): Promise<PipelineResult>;
  regenerate(
    kit: KitDocument,
    section: Section,
    opts: { days?: number },
    ctx: RunContext,
  ): Promise<PipelineResult>;
}

/** Structured pipeline failure - maps straight onto the batch error envelope. */
export class PipelineError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = 'PipelineError';
  }
}
