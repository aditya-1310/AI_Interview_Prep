// Client-side parsing/validation for the "upload a file of pairs" feature.
// Accepts { cases: [{ jd, companyUrl, days }] } or a bare array; also accepts
// company_url as an alias for companyUrl. Friendly errors over strictness.

export interface BatchPair {
  jd: string;
  companyUrl: string;
  days: number;
}

export const MAX_BATCH_CASES = 25;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Ensures a URL has a scheme so the server always receives an absolute one. */
export function normalizeCompanyUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return trimmed;
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

export function parseBatchCases(raw: string): BatchPair[] {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    throw new Error(
      `This file is not valid JSON. ${e instanceof Error ? e.message : ''}`.trim(),
    );
  }

  let arr: unknown[] | null = null;
  if (Array.isArray(data)) {
    arr = data;
  } else if (isObject(data) && Array.isArray(data.cases)) {
    arr = data.cases as unknown[];
  }
  if (!arr) {
    throw new Error(
      'Expected a JSON file shaped like { "cases": [{ "jd": "...", "companyUrl": "https://acme.com", "days": 5 }] } or a bare array of those pairs.',
    );
  }
  if (arr.length === 0) {
    throw new Error('This file contains no pairs.');
  }
  if (arr.length > MAX_BATCH_CASES) {
    throw new Error(
      `This file contains ${arr.length} pairs, but the maximum is ${MAX_BATCH_CASES}. Split it and upload again.`,
    );
  }

  const errors: string[] = [];
  const pairs: BatchPair[] = [];

  arr.forEach((entry, i) => {
    const n = i + 1;
    if (!isObject(entry)) {
      errors.push(`Pair ${n}: expected an object, found ${typeof entry}.`);
      return;
    }
    const jd = entry.jd;
    const rawUrl = entry.companyUrl ?? entry.company_url;
    const days = entry.days;
    const entryErrors: string[] = [];
    if (typeof jd !== 'string' || jd.trim().length === 0) {
      entryErrors.push('"jd" is missing or empty');
    }
    if (typeof rawUrl !== 'string' || rawUrl.trim().length === 0) {
      entryErrors.push('"companyUrl" is missing or empty');
    }
    if (typeof days !== 'number' || !Number.isInteger(days) || days < 1 || days > 60) {
      entryErrors.push('"days" must be a whole number between 1 and 60');
    }
    if (entryErrors.length > 0) {
      errors.push(`Pair ${n}: ${entryErrors.join('; ')}.`);
      return;
    }
    pairs.push({
      jd: (jd as string).trim(),
      companyUrl: normalizeCompanyUrl(rawUrl as string),
      days: days as number,
    });
  });

  if (errors.length > 0) {
    const shown = errors.slice(0, 3).join(' ');
    const suffix = errors.length > 3 ? ` (and ${errors.length - 3} more problems)` : '';
    throw new Error(`${shown}${suffix}`);
  }
  return pairs;
}
