// Minimal HTTP seams shared by every outbound service so tests can inject
// fakes without touching the network.

/** Anything shaped like fetch (global fetch by default). */
export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

/** Injectable sleep so retry/backoff paths test instantly offline. */
export type Sleep = (ms: number) => Promise<void>;

export const defaultSleep: Sleep = (ms) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

export const noSleep: Sleep = () => Promise.resolve();

/** AbortController with a timeout; caller must clear the timer via dispose(). */
export function timeoutSignal(ms: number, dispose: (fn: () => void) => void): AbortSignal {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`timeout after ${ms}ms`)), ms);
  dispose(() => clearTimeout(timer));
  return controller.signal;
}

export class HttpError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly bodyText: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}
