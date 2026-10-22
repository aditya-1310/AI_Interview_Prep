// Shared offline fakes for the pipeline tests: no network, no real API key.
import type { KitDocument } from '../../src/core/types';
import type { RunContext } from '../../src/core/ports';
import type { Fetcher, Sleep } from '../../src/services/http';
import type { LlmClient } from '../../src/services/gemini';

export const noSleep: Sleep = () => Promise.resolve();

export function htmlResponse(html: string, headers: Record<string, string> = {}): Response {
  return new Response(html, {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8', ...headers },
  });
}

export function notFound(): Response {
  return new Response('<html><body><h1>404</h1></body></html>', {
    status: 404,
    headers: { 'content-type': 'text/html' },
  });
}

export interface SiteFetcher extends Fetcher {
  requested: string[];
}

/**
 * A tiny offline "company site": map of pathname -> HTML body. robots.txt is
 * served from opts.robots when provided (otherwise 404). Unknown paths 404.
 */
export function makeSiteFetcher(
  pages: Record<string, string>,
  opts: { robots?: string } = {},
): SiteFetcher {
  const requested: string[] = [];
  const fetcher = async (url: string): Promise<Response> => {
    requested.push(url);
    const u = new URL(url);
    if (u.pathname === '/robots.txt') {
      if (opts.robots === undefined) {
        return new Response('no robots here', { status: 404, headers: { 'content-type': 'text/plain' } });
      }
      return new Response(opts.robots, { status: 200, headers: { 'content-type': 'text/plain' } });
    }
    const key = u.pathname.endsWith('/') ? `${u.pathname}index.html` : u.pathname;
    const body = pages[key];
    if (body === undefined) return notFound();
    return htmlResponse(body);
  };
  return Object.assign(fetcher, { requested }) as SiteFetcher;
}

/** Public DNS answers for the fake sites so the SSRF guard passes. */
export const publicResolver = async (): Promise<string[]> => ['93.184.216.34'];

/**
 * Scriptable LLM: handlers keyed by schemaName; records every call so tests
 * can assert the sequencing (one call per category, gap pass after miss...).
 */
export class FakeLlm implements LlmClient {
  calls: Array<{ schemaName: string; prompt: string }> = [];

  constructor(private handlers: Record<string, () => unknown> | ((schemaName: string) => unknown)) {}

  async generateJson<T>(schemaName: string, prompt: string): Promise<T> {
    this.calls.push({ schemaName, prompt });
    const handler =
      typeof this.handlers === 'function' ? this.handlers(schemaName) : this.handlers[schemaName];
    if (handler === undefined) {
      throw new Error(`FakeLlm: no handler for "${schemaName}"`);
    }
    return handler as T;
  }

  async generateText(): Promise<string> {
    throw new Error('FakeLlm.generateText not expected in these tests');
  }

  called(schemaName: string): number {
    return this.calls.filter((c) => c.schemaName === schemaName).length;
  }
}

export function noopCtx(log: string[] = []): RunContext {
  return {
    onProgress: (step, message) => {
      log.push(`${step}: ${message}`);
    },
    saveCheckpoint: async () => undefined,
    loadCheckpoint: async () => null,
  };
}

/** A minimal valid kit for envelope tests. */
export function minimalKit(): KitDocument {
  return {
    source: {
      company: 'Acme',
      company_url: 'https://acme.example',
      role: 'Senior Full-Stack Engineer',
      location: 'Remote',
      jd_chars: 1000,
      researched_at: '2026-10-22T00:00:00.000Z',
      pages_used: ['https://acme.example/'],
    },
    company_brief: { summary: 'Acme builds analytics.', what_they_do: 'Product telemetry.', sources: ['https://acme.example/'] },
    role: {
      title: 'Senior Full-Stack Engineer',
      seniority: 'senior',
      responsibilities: ['Build services'],
      requirements: [
        { id: 'r1', text: '5+ years with React', kind: 'technical', priority: 'must' },
        { id: 'r2', text: 'Mentoring junior engineers', kind: 'behavioural', priority: 'must' },
      ],
    },
    questions: [
      {
        id: 'q1',
        requirement_ids: ['r1', 'r2'],
        category: 'technical',
        prompt: 'Walk through a React performance problem you fixed.',
        answer_outline: 'Profiling; memoization; list virtualization.',
        difficulty: 2,
        origin: 'generated',
        item_state: 'pristine',
        pinned: false,
      },
    ],
    flashcards: [
      {
        id: 'f1',
        front: 'What does React reconciliation do?',
        back: 'Diffs the virtual DOM and applies minimal updates.',
        requirement_ids: ['r1'],
        origin: 'generated',
        item_state: 'pristine',
        pinned: false,
      },
    ],
    schedule: {
      days_available: 1,
      days: [{ day: 1, focus: 'Technical practice: React', question_ids: ['q1'], minutes: 30 }],
    },
    coverage: { uncovered_requirement_ids: [], passes: 1 },
    warnings: [],
  };
}
