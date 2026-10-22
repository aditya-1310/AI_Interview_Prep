// Endpoint-level typing for the REST surface in docs/03-api-contract.md.
// Kit types come from @contracts; the client-side document shapes here only
// extend them with the Mongo wrapper fields the API returns.

import { api } from './client';
import type { CreateKitInput, KitRecord } from '@contracts';
import type { Section } from '../lib/mutations';

/** The full kit document as served by GET /kits/:id (Mongo wrapper fields included). */
export interface KitRecordDoc extends KitRecord {
  _id?: string;
  id?: string;
  createdAt?: string;
  updatedAt?: string;
}

export function kitIdOf(record: KitRecordDoc): string {
  return record._id ?? record.id ?? '';
}

/** Narrowing guard for responses that are "the updated kit document". */
export function isKitRecord(v: unknown): v is KitRecordDoc {
  return (
    typeof v === 'object' &&
    v !== null &&
    'kit' in v &&
    'version' in v &&
    'status' in v
  );
}

export interface JobProgressEntry {
  step: string;
  message: string;
  at: string;
}

export interface JobState {
  id?: string;
  status: 'queued' | 'running' | 'completed' | 'failed';
  progress?: JobProgressEntry[];
  error?: { code: string; message: string } | null;
}

export interface KitListItem {
  id: string;
  company: string;
  role: string;
  status: KitRecord['status'];
  days: number;
  createdAt?: string;
}

export interface CreateKitResult {
  kitId: string;
  jobId: string | null;
  duplicate?: boolean;
}

export interface BatchCreateResult {
  jobs: Array<{ kitId: string; jobId: string | null }>;
}

export interface AuthUser {
  id: string;
  email: string;
}

export const authApi = {
  me: () => api.get<{ user: AuthUser | null }>('/auth/me', { skipAuthRedirect: true }),
  login: (email: string, password: string) => api.post<unknown>('/auth/login', { email, password }),
  register: (email: string, password: string) =>
    api.post<unknown>('/auth/register', { email, password }),
  logout: () => api.post<unknown>('/auth/logout'),
};

export const kitsApi = {
  list: () => api.get<KitListItem[]>('/kits'),
  create: (input: CreateKitInput & { force?: boolean }) => api.post<CreateKitResult>('/kits', input),
  batchCreate: (cases: CreateKitInput[]) =>
    api.post<BatchCreateResult>('/kits/batch', { cases }),
  get: (id: string) => api.get<KitRecordDoc>(`/kits/${id}`),
  remove: (id: string) => api.del<void>(`/kits/${id}`),
  getJob: (id: string) => api.get<JobState>(`/kits/${id}/job`),
  retryJob: (id: string) => api.post<{ jobId: string }>(`/kits/${id}/job/retry`),
  regenerate: (id: string, section: Section, opts?: { days?: number }) =>
    api.post<{ jobId: string }>(`/kits/${id}/regenerate`, {
      section,
      ...(opts?.days !== undefined ? { days: opts.days } : {}),
    }),
};
