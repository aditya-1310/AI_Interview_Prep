// Gemini REST client with the robustness the assignment demands: JSON mode,
// 90s timeout, retry on 429/5xx with exponential backoff (honouring the
// server's retryDelay hints), fallback models, one JSON-repair call, and a
// small inter-call gap to stay gentle with free-tier token/minute limits.
// The API key is only ever read from options/env and never logged.

import { PipelineError } from '../core/ports';
import type { Fetcher, Sleep } from './http';
import { defaultSleep } from './http';

const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

/** Exponential backoff ladder: 2s, 8s, 20s, 45s (4 retries per model). */
const RETRY_BACKOFF_MS = [2_000, 8_000, 20_000, 45_000];

/** Give up retrying a single model once this much wall time is burnt. */
const PER_MODEL_BUDGET_MS = 120_000;

/**
 * Global spacing between requests, shared by every case in the process. The
 * free tier caps gemini-3.5-flash around 10 requests/minute and the
 * flash-lite fallback around 15, so a 250ms gap bursts past the ceiling and
 * every call pays the full retry ladder (observed: one case at ~16 minutes).
 * ~13 RPM keeps the whole batch inside the budget; override with
 * GEMINI_MIN_CALL_GAP_MS.
 */
const DEFAULT_MIN_CALL_GAP_MS = 4_500;

/**
 * A 429 whose server hint is at least this long means the model's quota is
 * gone for a while - switch to the fallback immediately instead of waiting
 * the hint out twice on a dead model.
 */
const RATE_LIMIT_SWITCH_MS = 20_000;

export function defaultMinCallGapMs(): number {
  const raw = Number(process.env.GEMINI_MIN_CALL_GAP_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_MIN_CALL_GAP_MS;
}

export interface LlmCallOptions {
  temperature?: number;
  /** System instruction sent via the dedicated systemInstruction field, kept apart from untrusted user content. */
  system?: string;
  /**
   * Optional Gemini responseSchema. Verified working shape: UPPERCASE type
   * enums ("OBJECT" | "STRING" | "ARRAY" | "INTEGER" | "NUMBER" | "BOOLEAN"),
   * enum fields as { "type": "STRING", "enum": [...] }.
   */
  responseSchema?: Record<string, unknown>;
  maxOutputTokens?: number;
}

export interface LlmClient {
  generateJson<T>(schemaName: string, prompt: string, opts?: LlmCallOptions): Promise<T>;
  generateText(prompt: string, opts?: LlmCallOptions): Promise<string>;
}

export interface GeminiClientOptions {
  apiKey?: string;
  models?: string[];
  fetcher?: Fetcher;
  sleep?: Sleep;
  now?: () => number;
  timeoutMs?: number;
  minCallGapMs?: number;
  baseUrl?: string;
}

export function defaultModels(): string[] {
  const primary = process.env.GEMINI_MODEL?.trim() || 'gemini-3.5-flash';
  const fallbacks = (process.env.GEMINI_FALLBACK_MODELS || 'gemini-3.1-flash-lite')
    .split(',')
    .map((m) => m.trim())
    .filter(Boolean);
  return [primary, ...fallbacks.filter((m) => m !== primary)];
}

/** Strip ```json fences some models wrap around payloads. */
export function stripMarkdownFences(text: string): string {
  const trimmed = text.trim();
  const fenced = /^```[a-zA-Z0-9_-]*\s*\n([\s\S]*?)\n?\s*```$/.exec(trimmed);
  if (fenced) return fenced[1].trim();
  return trimmed;
}

class GeminiError extends Error {
  constructor(
    message: string,
    public readonly opts: {
      retryable: boolean;
      httpStatus?: number;
      retryDelayMs?: number;
    },
  ) {
    super(message);
    this.name = 'GeminiError';
  }
}

function parseRetryDelayMs(details: unknown): number | undefined {
  if (!Array.isArray(details)) return undefined;
  for (const d of details) {
    if (!d || typeof d !== 'object') continue;
    const raw = (d as Record<string, unknown>).retryDelay ?? (d as Record<string, unknown>).RetryDelay;
    if (typeof raw !== 'string') continue;
    const sec = /^(\d+(?:\.\d+)?)s$/i.exec(raw.trim());
    if (sec) return Math.round(parseFloat(sec[1]) * 1000);
    const ms = /^(\d+)ms$/i.exec(raw.trim());
    if (ms) return parseInt(ms[1], 10);
  }
  return undefined;
}

export function createGeminiClient(options: GeminiClientOptions = {}): LlmClient {
  const fetcher = options.fetcher ?? ((url, init) => fetch(url, init));
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? 90_000;
  const minCallGapMs = options.minCallGapMs ?? defaultMinCallGapMs();
  const baseUrl = options.baseUrl ?? GEMINI_BASE_URL;

  let lastRequestAt = 0;
  // Per-model 429 cooldowns: quotas are per-model, so a rate-limited primary
  // must not delay requests to a healthy fallback.
  const cooldownUntilByModel = new Map<string, number>();

  async function throttle(model: string): Promise<void> {
    const cooldown = (cooldownUntilByModel.get(model) ?? 0) - now();
    if (cooldown > 0) await sleep(cooldown);
    const gap = now() - lastRequestAt;
    if (gap < minCallGapMs) await sleep(minCallGapMs - gap);
    lastRequestAt = now();
  }

  function apiKey(): string {
    const key = options.apiKey ?? process.env.GEMINI_API_KEY;
    if (!key) {
      throw new PipelineError('LLM_UNAVAILABLE', 'GEMINI_API_KEY is not set (see .env.example)');
    }
    return key;
  }

  async function rawCall(model: string, prompt: string, jsonMode: boolean, opts?: LlmCallOptions): Promise<string> {
    const key = apiKey(); // throws PipelineError fast when the key is missing
    await throttle(model);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const generationConfig: Record<string, unknown> = {
        temperature: opts?.temperature ?? 0.2,
      };
      if (jsonMode) generationConfig.responseMimeType = 'application/json';
      if (opts?.responseSchema) generationConfig.responseSchema = opts.responseSchema;
      if (opts?.maxOutputTokens) generationConfig.maxOutputTokens = opts.maxOutputTokens;

      const body: Record<string, unknown> = {
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig,
      };
      if (opts?.system) {
        body.systemInstruction = { parts: [{ text: opts.system }] };
      }

      const res = await fetcher(`${baseUrl}/models/${encodeURIComponent(model)}:generateContent`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'X-goog-api-key': key,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      const bodyText = await res.text();

      if (!res.ok) {
        let message = `HTTP ${res.status} from model ${model}`;
        let retryDelayMs: number | undefined;
        try {
          const parsed = JSON.parse(bodyText) as {
            error?: { message?: string; details?: unknown };
          };
          if (parsed.error?.message) message = `${message}: ${parsed.error.message}`;
          retryDelayMs = parseRetryDelayMs(parsed.error?.details);
        } catch {
          // non-JSON error body; the HTTP status line is enough
        }
        if (res.status === 429 && retryDelayMs) {
          cooldownUntilByModel.set(model, Math.max(cooldownUntilByModel.get(model) ?? 0, now() + Math.min(retryDelayMs, 60_000)));
        }
        throw new GeminiError(message, {
          retryable: res.status === 429 || res.status >= 500,
          httpStatus: res.status,
          retryDelayMs,
        });
      }

      let data: unknown;
      try {
        data = JSON.parse(bodyText);
      } catch {
        throw new GeminiError(`non-JSON response from model ${model}`, { retryable: false });
      }

      const candidates = (data as { candidates?: unknown[] })?.candidates;
      const first = Array.isArray(candidates) ? candidates[0] : undefined;
      const parts = (first as { content?: { parts?: Array<{ text?: string }> } } | undefined)?.content?.parts;
      const text = Array.isArray(parts) ? parts.map((p) => (typeof p?.text === 'string' ? p.text : '')).join('') : '';
      if (text.trim()) return text;

      const blockReason = (data as { promptFeedback?: { blockReason?: string } })?.promptFeedback?.blockReason;
      const finish = (first as { finishReason?: string } | undefined)?.finishReason;
      const why = blockReason ? ` (blockReason: ${blockReason})` : finish ? ` (finishReason: ${finish})` : '';
      throw new GeminiError(`empty response from model ${model}${why}`, { retryable: false });
    } catch (err) {
      if (err instanceof PipelineError) throw err; // e.g. missing key - never retried
      if (err instanceof GeminiError) throw err;
      if (err instanceof Error && err.name === 'AbortError') {
        throw new GeminiError(`timeout after ${timeoutMs}ms on model ${model}`, { retryable: true });
      }
      if (err instanceof Error && err.message.startsWith('timeout after')) {
        throw new GeminiError(`${err.message} (model ${model})`, { retryable: true });
      }
      // fetch() network failures surface as TypeError - transient, worth a retry
      throw new GeminiError(
        `network error on model ${model}: ${err instanceof Error ? err.message : String(err)}`,
        { retryable: true },
      );
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * One model, with retries on 429/5xx/network. Rate limits (429) switch to
   * the fallback after 2 attempts - or immediately when the server's hint
   * says the quota is gone for a long while - because per-model quotas make
   * the fallback's separate allowance a faster cure than more waiting.
   * 5xx and network errors use the full exponential ladder. Non-retryable
   * failures bubble immediately.
   */
  async function callModel(
    model: string,
    prompt: string,
    jsonMode: boolean,
    opts?: LlmCallOptions,
  ): Promise<string> {
    const startedAt = now();
    let lastError: unknown;
    let rateLimitedAttempts = 0;
    for (let attempt = 0; attempt <= RETRY_BACKOFF_MS.length; attempt++) {
      try {
        return await rawCall(model, prompt, jsonMode, opts);
      } catch (err) {
        if (!(err instanceof GeminiError) || !err.opts.retryable) throw err;
        lastError = err;
        const isRateLimit = err.opts.httpStatus === 429;
        if (isRateLimit) rateLimitedAttempts++;
        const budgetLeft = PER_MODEL_BUDGET_MS - (now() - startedAt);
        const ladderExhausted = attempt === RETRY_BACKOFF_MS.length;
        const quotaVisiblyGone = isRateLimit && (err.opts.retryDelayMs ?? 0) >= RATE_LIMIT_SWITCH_MS;
        const rateQuotaSpent = isRateLimit && (quotaVisiblyGone || rateLimitedAttempts >= 2);
        if (ladderExhausted || rateQuotaSpent || budgetLeft <= 0) break;
        const backoff = RETRY_BACKOFF_MS[attempt];
        // A 429 with a server hint already set this model's cooldown, which
        // throttle() enforces before the next attempt - no double waiting.
        const hintedRateLimit = isRateLimit && err.opts.retryDelayMs !== undefined;
        const delay = hintedRateLimit
          ? 0
          : err.opts.retryDelayMs
            ? Math.max(backoff, Math.min(err.opts.retryDelayMs, 60_000))
            : backoff;
        if (delay > 0) await sleep(Math.min(delay, Math.max(budgetLeft, 1_000)));
      }
    }
    throw lastError instanceof Error ? lastError : new Error(`model ${model} failed`);
  }

  function parseJsonPayload(text: string): unknown {
    return JSON.parse(stripMarkdownFences(text));
  }

  async function generateJsonWithModel(
    model: string,
    schemaName: string,
    prompt: string,
    opts?: LlmCallOptions,
  ): Promise<unknown> {
    const text = await callModel(model, prompt, true, opts);
    try {
      return parseJsonPayload(text);
    } catch (parseErr) {
      // ONE repair call before giving up on this model.
      const parseMessage = parseErr instanceof Error ? parseErr.message : String(parseErr);
      const repairPrompt =
        `Your previous answer for a "${schemaName}" JSON payload could not be parsed (${parseMessage}). ` +
        `Return ONLY the corrected, valid JSON - no prose, no explanations, no markdown fences. ` +
        `Fix syntax errors and truncation; keep the same structure and field names as requested.\n\n` +
        `--- original request ---\n${prompt.slice(0, 6_000)}\n\n--- broken answer to fix ---\n${text.slice(0, 6_000)}`;
      const repaired = await callModel(model, repairPrompt, true, { ...opts, temperature: 0 });
      return parseJsonPayload(repaired);
    }
  }

  const models = () => options.models ?? defaultModels();

  /**
   * Try each model in order. Models whose 429 cooldown is still running are
   * SKIPPED without waiting (quotas are per-model; a rate-limited primary
   * must not delay a healthy fallback). If every model is cooling down, wait
   * out the nearest cooldown once and probe again. Rounds only continue
   * while rate limits are the obstacle - identical hard failures repeat, so
   * they end the call immediately.
   */
  async function runAcrossModels<T>(work: (model: string) => Promise<T>): Promise<T> {
    const failures: string[] = [];
    for (let round = 0; round < 3; round++) {
      failures.length = 0;
      const t = now();
      let available = models().filter((m) => (cooldownUntilByModel.get(m) ?? 0) <= t);
      for (const skipped of models().filter((m) => !available.includes(m))) {
        failures.push(`${skipped}: skipped (rate-limit cooldown active)`);
      }

      if (available.length === 0) {
        const next = Math.min(...models().map((m) => cooldownUntilByModel.get(m) ?? 0));
        const wait = Math.min(Math.max(next - t, 1_000), 60_000);
        await sleep(wait);
        const after = t + wait;
        for (const m of models()) {
          if ((cooldownUntilByModel.get(m) ?? 0) <= after) cooldownUntilByModel.delete(m);
        }
        available = models().filter((m) => (cooldownUntilByModel.get(m) ?? 0) <= after);
        if (available.length === 0) break; // still everything-limited: give up
      }

      let sawRateLimit = false;
      for (const model of available) {
        try {
          return await work(model);
        } catch (err) {
          if (err instanceof PipelineError) throw err;
          if (err instanceof GeminiError && err.opts.httpStatus === 429) sawRateLimit = true;
          failures.push(err instanceof Error ? `${model}: ${err.message}` : `${model}: ${String(err)}`);
        }
      }
      if (!sawRateLimit) break;
    }
    throw new PipelineError('LLM_UNAVAILABLE', `all Gemini models failed - ${failures.join(' | ')}`);
  }

  return {
    async generateJson<T>(schemaName: string, prompt: string, opts?: LlmCallOptions): Promise<T> {
      const value = await runAcrossModels((model) => generateJsonWithModel(model, schemaName, prompt, opts));
      return value as T;
    },
    generateText(prompt: string, opts?: LlmCallOptions): Promise<string> {
      return runAcrossModels((model) => callModel(model, prompt, false, opts));
    },
  };
}
