// Shared display labels for contract enums.

import type { ItemOrigin, ItemState, QuestionCategory, Requirement, RequirementKind, RequirementPriority } from '@contracts';

export const QUESTION_CATEGORIES: readonly QuestionCategory[] = [
  'technical',
  'behavioural',
  'system-design',
  'company-fit',
];

export const CATEGORY_LABELS: Record<QuestionCategory, string> = {
  technical: 'Technical',
  behavioural: 'Behavioural',
  'system-design': 'System design',
  'company-fit': 'Company fit',
};

export const DIFFICULTY_LABELS: Record<1 | 2 | 3, string> = {
  1: 'Easy',
  2: 'Medium',
  3: 'Hard',
};

export const CONFIDENCE_LABELS: Record<1 | 2 | 3, string> = {
  1: 'Not confident',
  2: 'Shaky',
  3: 'Solid',
};

export const PRIORITY_LABELS: Record<RequirementPriority, string> = {
  must: 'Must-have',
  nice: 'Nice-to-have',
};

export const KIND_LABELS: Record<RequirementKind, string> = {
  technical: 'Technical',
  behavioural: 'Behavioural',
  domain: 'Domain',
};

export const SECTION_LABELS: Record<string, string> = {
  brief: 'Brief',
  technical: 'Technical questions',
  behavioural: 'Behavioural questions',
  'system-design': 'System design questions',
  'company-fit': 'Company fit questions',
  schedule: 'Schedule',
};

/** Badge describing where an item came from and what the user did to it. */
export function originBadge(item: { origin: ItemOrigin; item_state: ItemState; pinned: boolean }): {
  label: string;
  className: string;
} {
  if (item.pinned) {
    return { label: 'Pinned', className: 'border-indigo-500/50 bg-indigo-500/15 text-indigo-300' };
  }
  if (item.origin === 'manual') {
    return { label: 'Manual', className: 'border-emerald-500/50 bg-emerald-500/15 text-emerald-300' };
  }
  if (item.item_state === 'edited') {
    return { label: 'Edited', className: 'border-amber-500/50 bg-amber-500/15 text-amber-300' };
  }
  return { label: 'Generated', className: 'border-slate-700 bg-slate-800/60 text-slate-400' };
}

/** Short text snippet of a question prompt, for chips. */
export function questionSnippet(prompt: string, max = 48): string {
  const single = prompt.replace(/\s+/g, ' ').trim();
  return single.length > max ? `${single.slice(0, max - 1)}…` : single;
}

export function requirementById(requirements: Requirement[]): Map<string, Requirement> {
  return new Map(requirements.map((r) => [r.id, r]));
}
