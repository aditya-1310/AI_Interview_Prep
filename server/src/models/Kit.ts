import { createHash } from 'node:crypto';
import { Schema, model, Types, type HydratedDocument, type Model } from 'mongoose';
import type { KitRecord } from '../core/types';

/**
 * Duplicate-submission hash over the creation input (jd + companyUrl + days).
 * Deterministic sha1 hex - identical inputs must map to the same job.
 */
export function inputHashFor(jd: string, companyUrl: string, days: number): string {
  return createHash('sha1').update(`${jd}\u0000${companyUrl}\u0000${days}`, 'utf8').digest('hex');
}

export interface KitDoc extends KitRecord {
  _id: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

export interface KitModel extends Model<KitDoc> {
  inputHashFor(jd: string, companyUrl: string, days: number): string;
}

// The nested kit is stored loosely (Mixed): core/schemas.ts (kitSchema) is the
// validator of record for kits, practice stays a plain map, and Mongo only
// persists what the pipeline and builder produce.
const kitSchema = new Schema<KitDoc, KitModel>(
  {
    userId: { type: String, required: true, index: true },
    status: {
      type: String,
      enum: ['pending', 'ready', 'failed'],
      required: true,
      default: 'pending',
    },
    version: { type: Number, required: true, default: 1, min: 1 },
    input: {
      jd: { type: String, required: true },
      companyUrl: { type: String, required: true },
      days: { type: Number, required: true, min: 1, max: 60 },
      inputHash: { type: String, required: true },
    },
    kit: { type: Schema.Types.Mixed, required: true, default: () => ({}) },
    practice: { type: Schema.Types.Mixed, required: true, default: () => ({}) },
  },
  { timestamps: true },
);

kitSchema.index({ userId: 1, 'input.inputHash': 1 });
kitSchema.statics.inputHashFor = inputHashFor;

export const Kit = model<KitDoc, KitModel>('Kit', kitSchema);
export type KitHydrated = HydratedDocument<KitDoc>;
