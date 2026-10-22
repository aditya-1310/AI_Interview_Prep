import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { ZodError } from 'zod';

/**
 * Structured API failure. Always rendered as
 * `{ error: { code, message, details? }, ...extras }`.
 * `extras` is spread at the top level of the JSON body (e.g. `currentKit`
 * for version conflicts).
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
    readonly extras?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

type AsyncRoute = (req: Request, res: Response, next: NextFunction) => unknown;

/** Wrap async route handlers so rejections reach the central error handler. */
export const asyncHandler =
  (fn: AsyncRoute): RequestHandler =>
  (req, res, next) => {
    void Promise.resolve(fn(req, res, next)).catch(next);
  };

function zodDetails(err: ZodError): unknown {
  return { fields: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) };
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler(err: unknown, req: Request, res: Response, next: NextFunction): void {
  if (res.headersSent) {
    next(err);
    return;
  }
  if (err instanceof ApiError) {
    const error: Record<string, unknown> = { code: err.code, message: err.message };
    if (err.details !== undefined) error.details = err.details;
    const body: Record<string, unknown> = { error };
    if (err.extras) Object.assign(body, err.extras);
    res.status(err.status).json(body);
    return;
  }
  if (err instanceof ZodError) {
    res.status(400).json({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Request validation failed',
        details: zodDetails(err),
      },
    });
    return;
  }
  const maybe = err as { type?: string; status?: number; expose?: boolean };
  if (maybe?.type === 'entity.parse.failed') {
    res.status(400).json({
      error: { code: 'INVALID_JSON', message: 'Request body is not valid JSON' },
    });
    return;
  }
  console.error('[api] unhandled error:', err);
  res.status(500).json({ error: { code: 'INTERNAL', message: 'Internal server error' } });
}
