import type { Request, RequestHandler } from 'express';
import { ApiError } from './errors';

// Session payload typing shared by every layer that reads req.session.
declare module 'express-session' {
  interface SessionData {
    user?: SessionUser;
  }
}

export interface SessionUser {
  id: string;
  email: string;
}

export function getSessionUser(req: Request): SessionUser | undefined {
  return req.session?.user;
}

/** Throws the standard 401 when the session has no user. */
export function requireUser(req: Request): SessionUser {
  const user = getSessionUser(req);
  if (!user) throw new ApiError(401, 'UNAUTHENTICATED', 'Sign in to continue');
  return user;
}

/** Route guard: 401 unless the request carries an authenticated session. */
export const requireAuth: RequestHandler = (req, _res, next) => {
  if (!getSessionUser(req)) {
    next(new ApiError(401, 'UNAUTHENTICATED', 'Sign in to continue'));
    return;
  }
  next();
};

/**
 * Regenerate the session (fresh id, session-fixation defence) then attach the
 * user and persist. Register and login MUST go through this.
 */
export async function establishSession(req: Request, user: SessionUser): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    req.session.regenerate((err) => (err ? reject(err) : resolve()));
  });
  req.session.user = user;
  await new Promise<void>((resolve, reject) => {
    req.session.save((err) => (err ? reject(err) : resolve()));
  });
}

export async function destroySession(req: Request): Promise<void> {
  await new Promise<void>((resolve) => {
    req.session.destroy(() => resolve());
  });
}
