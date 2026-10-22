// Public discussion search: Hacker News (Algolia API, primary and reliable)
// plus Reddit search JSON on a best-effort basis - Reddit currently serves an
// HTML logged-out wall to unauthenticated clients, so a non-JSON response is
// detected and recorded as SOURCE_SKIPPED instead of burning retries.
// Every source failure is a warning; a case never dies here.

import type { Warning } from '../core/types';
import type { Fetcher, Sleep } from './http';
import { defaultSleep } from './http';

export interface DiscussionItem {
  title: string;
  url: string;
  source: 'hackernews' | 'reddit';
}

export interface DiscussionResult {
  items: DiscussionItem[];
  warnings: Warning[];
}

export interface DiscussionOptions {
  fetcher?: Fetcher;
  sleep?: Sleep;
  timeoutMs?: number;
  perCallDelayMs?: number;
}

const HN_SEARCH_URL = 'https://hn.algolia.com/api/v1/search';
const REDDIT_SEARCH_URL = 'https://www.reddit.com/search.json';
const USER_AGENT = 'ai-interview-prep-kit/1.0 (batch evaluation; +https://github.com/aditya-1310/AI_Interview_Prep)';

async function fetchJson(url: string, headers: Record<string, string>, timeoutMs: number, fetcher: Fetcher): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetcher(url, { headers, signal: controller.signal });
    const contentType = (res.headers.get('content-type') ?? '').toLowerCase();
    const bodyText = await res.text();
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    if (!contentType.includes('json')) {
      // e.g. Reddit's logged-out HTML wall - not JSON, skip without retrying
      throw new NotJsonError(`content-type "${contentType || 'unknown'}" is not JSON`);
    }
    return JSON.parse(bodyText);
  } finally {
    clearTimeout(timer);
  }
}

class NotJsonError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotJsonError';
  }
}

interface HnHit {
  objectID?: string | number;
  title?: string;
  url?: string | null;
}

interface RedditChild {
  data?: { title?: string; permalink?: string };
}

function parseHn(data: unknown): DiscussionItem[] {
  const hits = (data as { hits?: HnHit[] })?.hits;
  if (!Array.isArray(hits)) return [];
  return hits
    .filter((h) => typeof h?.title === 'string' && h.title.trim())
    .map((h) => ({
      title: (h.title as string).trim().slice(0, 300),
      url:
        typeof h.url === 'string' && h.url.startsWith('http')
          ? h.url
          : `https://news.ycombinator.com/item?id=${String(h.objectID ?? '')}`,
      source: 'hackernews' as const,
    }));
}

function parseReddit(data: unknown): DiscussionItem[] {
  const children = (data as { data?: { children?: RedditChild[] } })?.data?.children;
  if (!Array.isArray(children)) return [];
  return children
    .map((c) => c.data)
    .filter((d): d is { title: string; permalink?: string } =>
      typeof d?.title === 'string' ? d.title.trim().length > 0 : false,
    )
    .map((d) => ({
      title: d.title.trim().slice(0, 300),
      url: d.permalink ? `https://www.reddit.com${d.permalink}` : REDDIT_SEARCH_URL,
      source: 'reddit' as const,
    }));
}

/**
 * Search public discussion of "${company} interview". HN first (reliable),
 * Reddit second (best-effort). Nothing found anywhere is an honest warning,
 * not an error.
 */
export async function searchDiscussions(company: string, opts: DiscussionOptions = {}): Promise<DiscussionResult> {
  const fetcher = opts.fetcher ?? ((url, init) => fetch(url, init));
  const sleep = opts.sleep ?? defaultSleep;
  const timeoutMs = opts.timeoutMs ?? 8_000;
  const perCallDelayMs = opts.perCallDelayMs ?? 600;
  const items: DiscussionItem[] = [];
  const warnings: Warning[] = [];
  const query = `${company} interview`;

  try {
    const url = `${HN_SEARCH_URL}?query=${encodeURIComponent(query)}&tags=story&hitsPerPage=5`;
    items.push(...parseHn(await fetchJson(url, { 'user-agent': USER_AGENT }, timeoutMs, fetcher)));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    warnings.push({ code: 'SOURCE_SKIPPED', message: `Hacker News discussion search skipped: ${message}` });
  }

  await sleep(perCallDelayMs);

  try {
    const url = `${REDDIT_SEARCH_URL}?q=${encodeURIComponent(query)}&limit=5`;
    const data = await fetchJson(
      url,
      { 'user-agent': USER_AGENT, accept: 'application/json' },
      timeoutMs,
      fetcher,
    );
    items.push(...parseReddit(data));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    warnings.push({ code: 'SOURCE_SKIPPED', message: `Reddit discussion search skipped: ${message}` });
  }

  if (items.length === 0) {
    warnings.push({
      code: 'NO_DISCUSSION_FOUND',
      message: `no public discussion found for "${company} interviews" (HN and Reddit came up empty or were skipped)`,
    });
  }

  return { items, warnings };
}
