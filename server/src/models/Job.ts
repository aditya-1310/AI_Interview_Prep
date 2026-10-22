import { Schema, model, Types, type HydratedDocument, type Model } from 'mongoose';
import type { Section } from '../core/ports';

export type JobType = 'generate' | 'regenerate';
export type JobStatus = 'queued' | 'running' | 'completed' | 'failed';

export interface JobProgressEntry {
  step: string;
  message: string;
  at: string;
}

export interface JobError {
  code: string;
  message: string;
}

export interface JobDoc {
  _id: Types.ObjectId;
  kitId: string;
  userId: string;
  type: JobType;
  section?: Section;
  /** Present when a regenerate asked for a different day count. */
  days?: number;
  status: JobStatus;
  progress: JobProgressEntry[];
  /** Stage -> last completed output; failed runs resume from here. */
  checkpoints: Record<string, unknown>;
  error?: JobError;
  inputHash: string;
  startedAt?: Date;
  finishedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const SECTIONS: Section[] = [
  'brief',
  'technical',
  'behavioural',
  'system-design',
  'company-fit',
  'schedule',
];

const jobSchema = new Schema<JobDoc, Model<JobDoc>>(
  {
    kitId: { type: String, required: true, index: true },
    userId: { type: String, required: true, index: true },
    type: { type: String, enum: ['generate', 'regenerate'], required: true },
    section: { type: String, enum: SECTIONS },
    days: { type: Number, min: 1, max: 60 },
    status: {
      type: String,
      enum: ['queued', 'running', 'completed', 'failed'],
      required: true,
      default: 'queued',
    },
    progress: {
      type: [{ _id: false, step: String, message: String, at: String }],
      default: [],
    },
    checkpoints: { type: Schema.Types.Mixed, default: () => ({}) },
    error: { code: String, message: String },
    inputHash: { type: String, required: true, index: true },
    startedAt: Date,
    finishedAt: Date,
  },
  { timestamps: true },
);

jobSchema.index({ userId: 1, inputHash: 1, status: 1 });
jobSchema.index({ kitId: 1, createdAt: -1 });

export const Job = model<JobDoc>('Job', jobSchema);
export type JobHydrated = HydratedDocument<JobDoc>;
