// Typed environment config. Loads the repo-root .env (server runs from
// server/src, so the root is two levels up); real process.env always wins
// because dotenv does not overwrite existing variables by default.
import { config as loadDotenv } from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const repoRoot = path.resolve(here, '..', '..');
loadDotenv({ path: path.join(repoRoot, '.env') });

export interface AppConfig {
  mongoUri: string;
  sessionSecret: string;
  port: number;
  isProd: boolean;
  allowPrivate: boolean;
  clientOrigin: string;
}

function parsePort(raw: string | undefined, fallback: number): number {
  const n = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(n) && n > 0 && n <= 65_535 ? n : fallback;
}

const mongoUri = process.env.MONGODB_URI?.trim() ?? '';
const sessionSecret = process.env.SESSION_SECRET?.trim() ?? '';

const missing = [
  ...(mongoUri ? [] : ['MONGODB_URI']),
  ...(sessionSecret ? [] : ['SESSION_SECRET']),
];
if (missing.length > 0) {
  // Fail fast with names only - never log secret values.
  throw new Error(
    `Missing required environment variable(s): ${missing.join(', ')}. ` +
      'Copy .env.example to .env at the repo root and fill them in.',
  );
}

export const config: AppConfig = {
  mongoUri,
  sessionSecret,
  port: parsePort(process.env.PORT, 8787),
  isProd: process.env.NODE_ENV === 'production',
  allowPrivate: process.env.ALLOW_PRIVATE_ADDRESSES === 'true',
  clientOrigin: process.env.CLIENT_ORIGIN?.trim() || 'http://localhost:5173',
};
