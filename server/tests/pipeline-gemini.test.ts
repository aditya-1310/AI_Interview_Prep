import { describe, expect, it } from 'vitest';
import { PipelineError } from '../src/core/ports';
import { createGeminiClient, stripMarkdownFences } from '../src/services/gemini';
import type { Fetcher, Sleep } from '../src/services/http';

interface Recorded {
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

interface Rig {
  fetcher: Fetcher;
  sleep: Sleep;
  requests: Recorded[];
  sleeps: number[];
}

function rig(respond: (record: Recorded) => Response): Rig {
  const requests: Recorded[] = [];
  const sleeps: number[] = [];
  const sleep: Sleep = async (ms) => {
    sleeps.push(ms);
  };
  const fetcher: Fetcher = async (url, init) => {
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>));
    const record: Recorded = { url, headers, body: JSON.parse(String(init?.body)) };
    requests.push(record);
    return respond(record);
  };
  return { fetcher, sleep, requests, sleeps };
}

function geminiOk(text: string): Response {
  return new Response(
    JSON.stringify({
      candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP' }],
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

function geminiErr(status: number, extra: Record<string, unknown> = {}): Response {
  return new Response(
    JSON.stringify({ error: { code: status, message: 'provider says no', ...extra } }),
    { status, headers: { 'content-type': 'application/json' } },
  );
}

const CLIENT_BASE = {
  apiKey: 'test-key',
  models: ['model-a', 'model-b'],
  now: () => 0,
  minCallGapMs: 0,
};

function modelsUsed(requests: Recorded[]): string[] {
  return requests.map((r) => r.url.split('/models/')[1].split(':')[0]);
}

describe('gemini client (offline, fake fetcher)', () => {
  it('sends the key via X-goog-api-key, JSON mime mode and parses the payload', async () => {
    const { fetcher, sleep, requests } = rig(() => geminiOk('{"a":1}'));
    const llm = createGeminiClient({ ...CLIENT_BASE, fetcher, sleep });
    const value = await llm.generateJson('test', 'hello');
    expect(value).toEqual({ a: 1 });
    expect(requests).toHaveLength(1);
    expect(requests[0].headers['X-goog-api-key']).toBe('test-key');
    expect(requests[0].url).toContain(
      'https://generativelanguage.googleapis.com/v1beta/models/model-a:generateContent',
    );
    const body = requests[0].body as { generationConfig: Record<string, unknown>; contents: unknown[] };
    expect(body.generationConfig.responseMimeType).toBe('application/json');
    expect(body.contents).toHaveLength(1);
  });

  it('accepts JSON wrapped in markdown fences', async () => {
    expect(stripMarkdownFences('```json\n{"a":2}\n```')).toBe('{"a":2}');
    const { fetcher, sleep } = rig(() => geminiOk('```json\n{"ok":true}\n```'));
    const llm = createGeminiClient({ ...CLIENT_BASE, fetcher, sleep });
    await expect(llm.generateJson('test', 'x')).resolves.toEqual({ ok: true });
  });

  it('ignores a thoughtSignature sibling field next to the text part', async () => {
    const response = new Response(
      JSON.stringify({
        candidates: [
          {
            content: { role: 'model', parts: [{ text: '{"v":7}', thoughtSignature: 'sig' }] },
            finishReason: 'STOP',
          },
        ],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
    const { fetcher, sleep } = rig(() => response);
    const llm = createGeminiClient({ ...CLIENT_BASE, fetcher, sleep });
    await expect(llm.generateJson('test', 'x')).resolves.toEqual({ v: 7 });
  });

  it('makes exactly ONE repair call when the payload is not parseable JSON', async () => {
    const { fetcher, sleep, requests } = rig((record) => {
      const body = record.body as { contents: Array<{ parts: Array<{ text: string }> }> };
      const isRepair = body.contents[0].parts[0].text.includes('corrected, valid JSON');
      return isRepair ? geminiOk('{"repaired":true}') : geminiOk('{not json at all');
    });
    const llm = createGeminiClient({ ...CLIENT_BASE, fetcher, sleep });
    const value = await llm.generateJson('test', 'prompt');
    expect(value).toEqual({ repaired: true });
    expect(requests).toHaveLength(2);
    expect(modelsUsed(requests)).toEqual(['model-a', 'model-a']); // repair stays on the same model
  });

  it('retries a 429 with backoff (honouring retryDelay hints) and stays on the same model', async () => {
    let call = 0;
    const { fetcher, sleep, requests, sleeps } = rig(() => {
      call++;
      return call === 1
        ? geminiErr(429, {
            details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '3s' }],
          })
        : geminiOk('{"done":true}');
    });
    const llm = createGeminiClient({ ...CLIENT_BASE, fetcher, sleep });
    await expect(llm.generateJson('test', 'x')).resolves.toEqual({ done: true });
    expect(requests).toHaveLength(2);
    expect(modelsUsed(requests)).toEqual(['model-a', 'model-a']);
    // first ladder step is 2s; the server hint of 3s raises it
    expect(sleeps).toEqual([3_000]);
  });

  it('switches to the fallback after a per-model rate-limit quota is spent (429 x2)', async () => {
    const { fetcher, sleep, requests, sleeps } = rig((record) => {
      const model = record.url.split('/models/')[1].split(':')[0];
      return model === 'model-a'
        ? geminiErr(429, { details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '1s' }] })
        : geminiOk('{"rescued":true}');
    });
    const llm = createGeminiClient({ ...CLIENT_BASE, fetcher, sleep });
    await expect(llm.generateJson('test', 'x')).resolves.toEqual({ rescued: true });
    // only 2 attempts on the rate-limited primary (its RPM quota is spent),
    // then the fallback model's separate quota answers immediately
    expect(modelsUsed(requests)).toEqual(['model-a', 'model-a', 'model-b']);
    expect(sleeps.length).toBeGreaterThan(0); // honoured the shared cooldown
  });

  it('switches to the fallback IMMEDIATELY when the 429 hint says the quota is gone for a while', async () => {
    const { fetcher, sleep, requests, sleeps } = rig((record) => {
      const model = record.url.split('/models/')[1].split(':')[0];
      return model === 'model-a'
        ? geminiErr(429, {
            details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '60s' }],
          })
        : geminiOk('{"fast":true}');
    });
    const llm = createGeminiClient({ ...CLIENT_BASE, fetcher, sleep });
    await expect(llm.generateJson('test', 'x')).resolves.toEqual({ fast: true });
    expect(modelsUsed(requests)).toEqual(['model-a', 'model-b']); // one probe, then straight over
    expect(sleeps).toEqual([]); // never waited the 60s hint on the dead model
  });

  it('waits out the largest hint once and retries when EVERY model is rate-limited', async () => {
    let call = 0;
    const { fetcher, sleep, requests, sleeps } = rig(() => {
      call++;
      return call <= 3
        ? geminiErr(429, {
            details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '25s' }],
          })
        : geminiOk('{"recovered":true}');
    });
    const llm = createGeminiClient({ ...CLIENT_BASE, fetcher, sleep });
    await expect(llm.generateJson('test', 'x')).resolves.toEqual({ recovered: true });
    expect(modelsUsed(requests)).toEqual(['model-a', 'model-b', 'model-a', 'model-b']);
    expect(sleeps.length).toBeGreaterThanOrEqual(1); // the cooperative inter-round wait
  });

  it('exhausts retries on the primary then succeeds on the fallback model', async () => {
    const { fetcher, sleep, requests, sleeps } = rig((record) => {
      const model = record.url.split('/models/')[1].split(':')[0];
      return model === 'model-a' ? geminiErr(503) : geminiOk('{"fromFallback":true}');
    });
    const llm = createGeminiClient({ ...CLIENT_BASE, fetcher, sleep });
    const value = await llm.generateJson('test', 'x');
    expect(value).toEqual({ fromFallback: true });
    // 1 initial + 4 retries on model-a, then model-b
    expect(modelsUsed(requests)).toEqual(['model-a', 'model-a', 'model-a', 'model-a', 'model-a', 'model-b']);
    expect(sleeps).toEqual([2_000, 8_000, 20_000, 45_000]);
  });

  it('throws PipelineError(LLM_UNAVAILABLE) once every model is dead', async () => {
    const { fetcher, sleep, requests } = rig(() => geminiErr(500));
    const llm = createGeminiClient({ ...CLIENT_BASE, fetcher, sleep });
    await expect(llm.generateJson('test', 'x')).rejects.toBeInstanceOf(PipelineError);
    await expect(llm.generateJson('test', 'x')).rejects.toMatchObject({ code: 'LLM_UNAVAILABLE' });
    expect(modelsUsed(requests).filter((m) => m === 'model-a')).toHaveLength(10); // 2 calls x 5 attempts
    expect(modelsUsed(requests).filter((m) => m === 'model-b')).toHaveLength(10);
  });

  it('does not retry non-retryable 4xx and moves straight to the fallback', async () => {
    const { fetcher, sleep, requests } = rig((record) => {
      const model = record.url.split('/models/')[1].split(':')[0];
      return model === 'model-a' ? geminiErr(400) : geminiOk('{"ok":1}');
    });
    const llm = createGeminiClient({ ...CLIENT_BASE, fetcher, sleep });
    await expect(llm.generateJson('test', 'x')).resolves.toEqual({ ok: 1 });
    expect(modelsUsed(requests)).toEqual(['model-a', 'model-b']);
  });

  it('throws LLM_UNAVAILABLE before any request when the key is missing', async () => {
    const { fetcher, sleep, requests, sleeps } = rig(() => geminiOk('{}'));
    const previous = process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    try {
      const llm = createGeminiClient({ ...CLIENT_BASE, fetcher, sleep, apiKey: undefined });
      await expect(llm.generateJson('test', 'x')).rejects.toMatchObject({ code: 'LLM_UNAVAILABLE' });
      expect(requests).toHaveLength(0);
      expect(sleeps).toEqual([]); // failed fast, no backoff ladder
    } finally {
      if (previous !== undefined) process.env.GEMINI_API_KEY = previous;
    }
  });

  it('generateText returns the raw text', async () => {
    const { fetcher, sleep } = rig(() => geminiOk('plain answer'));
    const llm = createGeminiClient({ ...CLIENT_BASE, fetcher, sleep });
    await expect(llm.generateText('x')).resolves.toBe('plain answer');
  });
});
