import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { User } from '../models/User';
import { asyncHandler, ApiError } from '../middleware/errors';
import {
  destroySession,
  establishSession,
  getSessionUser,
  requireAuth,
} from '../middleware/auth';

const BCRYPT_COST = 10;

const registerSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(8, 'Password must be at least 8 characters').max(200),
});

const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1),
});

function isDuplicateKeyError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === 11_000
  );
}

export const authRouter = Router();

authRouter.post(
  '/register',
  asyncHandler(async (req, res) => {
    const body = registerSchema.parse(req.body ?? {});
    const passwordHash = await bcrypt.hash(body.password, BCRYPT_COST);
    let user;
    try {
      user = await User.create({ email: body.email, passwordHash });
    } catch (err) {
      if (isDuplicateKeyError(err)) {
        throw new ApiError(409, 'EMAIL_TAKEN', 'An account with this email already exists');
      }
      throw err;
    }
    const sessionUser = { id: String(user._id), email: user.email };
    await establishSession(req, sessionUser);
    res.status(201).json({ user: sessionUser });
  }),
);

authRouter.post(
  '/login',
  asyncHandler(async (req, res) => {
    const body = loginSchema.parse(req.body ?? {});
    const user = await User.findOne({ email: body.email });
    const ok = user !== null && (await bcrypt.compare(body.password, user.passwordHash));
    if (!user || !ok) {
      throw new ApiError(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect');
    }
    const sessionUser = { id: String(user._id), email: user.email };
    await establishSession(req, sessionUser);
    res.json({ user: sessionUser });
  }),
);

authRouter.post(
  '/logout',
  asyncHandler(async (req, res) => {
    await destroySession(req);
    res.clearCookie('prep.sid');
    res.status(204).send();
  }),
);

authRouter.get(
  '/me',
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = getSessionUser(req);
    if (!user) throw new ApiError(401, 'UNAUTHENTICATED', 'Sign in to continue');
    res.json({ user });
  }),
);
