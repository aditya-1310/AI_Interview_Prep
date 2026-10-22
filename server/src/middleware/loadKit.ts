import type { Request, RequestHandler } from 'express';
import { isValidObjectId } from 'mongoose';
import { Kit, type KitDoc } from '../models/Kit';
import { ApiError } from './errors';
import { getSessionUser } from './auth';

/**
 * Ownership rule: a kit another user cannot see does not exist for them.
 * Pure so tests can pin the behaviour with fake documents.
 */
export function kitVisibleTo(
  kit: { userId: string } | null | undefined,
  userId: string | null | undefined,
): boolean {
  return Boolean(kit && userId && kit.userId === userId);
}

/** Resolve params.id to the caller's own kit, or throw the standard 404. */
export async function findOwnedKit(req: Request): Promise<KitDoc> {
  const user = getSessionUser(req);
  if (!user) throw new ApiError(401, 'UNAUTHENTICATED', 'Sign in to continue');
  const id = req.params.id;
  if (!isValidObjectId(id)) throw new ApiError(404, 'NOT_FOUND', 'Kit not found');
  const kit = await Kit.findById(id);
  if (!kit || !kitVisibleTo(kit, user.id)) throw new ApiError(404, 'NOT_FOUND', 'Kit not found');
  return kit;
}

export interface KitLocals {
  kit?: KitDoc;
}

/** Express middleware: attaches the owned kit to res.locals.kit. */
export const loadKit: RequestHandler = async (req, res, next) => {
  try {
    res.locals.kit = await findOwnedKit(req);
    next();
  } catch (err) {
    next(err);
  }
};

export function getLoadedKit(res: { locals: KitLocals }): KitDoc {
  const kit = res.locals.kit;
  if (!kit) throw new ApiError(500, 'INTERNAL', 'Kit was not loaded for this route');
  return kit;
}
