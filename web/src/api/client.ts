// Typed fetch wrapper for the same-origin /api surface. Unwraps the
// { error: { code, message } } envelope into a thrown ApiError, converts
// network failures into a friendly NETWORK_ERROR, and globally redirects to
// /login on 401 UNAUTHENTICATED (opt-out for the session bootstrap calls).

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;
  /** Present on 409 VERSION_CONFLICT: the server's current kit document. */
  readonly currentKit?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown, currentKit?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
    this.currentKit = currentKit;
  }
}

export function errMessage(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  if (e instanceof Error && e.message) return e.message;
  return 'Something went wrong. Please try again.';
}

type UnauthorizedHandler = () => void;
let unauthorizedHandler: UnauthorizedHandler | null = null;

/** Registered by the app shell so a 401 redirects through the router. */
export function setUnauthorizedHandler(fn: UnauthorizedHandler | null): void {
  unauthorizedHandler = fn;
}

export interface RequestOptions {
  /** Skip the global redirect (used by /auth/me so anonymous pages stay put). */
  skipAuthRedirect?: boolean;
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  options?: RequestOptions,
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method,
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      credentials: 'same-origin',
    });
  } catch {
    throw new ApiError(
      0,
      'NETWORK_ERROR',
      'Cannot reach the server. It may still be starting up — try again in a moment.',
    );
  }

  if (res.status === 204) {
    return undefined as T;
  }

  let payload: unknown = null;
  const text = await res.text();
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }

  if (!res.ok) {
    const envelope = isRecord(payload) ? payload.error : undefined;
    const errObj = isRecord(envelope) ? envelope : {};
    const code = typeof errObj.code === 'string' ? errObj.code : 'UNKNOWN_ERROR';
    const message =
      typeof errObj.message === 'string' && errObj.message
        ? errObj.message
        : `Request failed with status ${res.status}.`;
    const currentKit =
      extractCurrentKit(errObj.currentKit) ?? extractCurrentKit(errObj.details);
    if (res.status === 401 && code === 'UNAUTHENTICATED' && !options?.skipAuthRedirect) {
      unauthorizedHandler?.();
    }
    throw new ApiError(res.status, code, message, errObj.details, currentKit);
  }

  return payload as T;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function extractCurrentKit(v: unknown): unknown {
  if (isRecord(v) && isRecord(v.currentKit)) return v.currentKit;
  return undefined;
}

export const api = {
  request,
  get: <T>(path: string, options?: RequestOptions) => request<T>('GET', path, undefined, options),
  post: <T>(path: string, body?: unknown, options?: RequestOptions) =>
    request<T>('POST', path, body, options),
  patch: <T>(path: string, body?: unknown, options?: RequestOptions) =>
    request<T>('PATCH', path, body, options),
  del: <T>(path: string, body?: unknown, options?: RequestOptions) =>
    request<T>('DELETE', path, body, options),
};
