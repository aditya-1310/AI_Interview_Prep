import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type Express } from 'express';
import session from 'express-session';
import MongoStore from 'connect-mongo';
import mongoose from 'mongoose';
import type { MongoClient } from 'mongodb';
import { config } from './config';
import { connectDb } from './db';
import { authRouter } from './routes/auth';
import { kitsRouter } from './routes/kits';
import { errorHandler } from './middleware/errors';
import { setGenerator } from './jobs/runner';
import type { KitGenerator } from './core/ports';

const here = path.dirname(fileURLToPath(import.meta.url));
const webDistDir = path.resolve(here, '..', '..', 'web', 'dist');
const indexHtmlPath = path.join(webDistDir, 'index.html');

export interface CreateAppOptions {
  /** Inject a generator directly (tests / tools); overrides lazy wiring. */
  generator?: KitGenerator;
}

const SESSION_COOKIE_MAX_AGE = 7 * 24 * 60 * 60 * 1000; // 7 days

/**
 * App factory separate from the boot side-effect so tests can import and
 * exercise the API without listening. Requires mongoose to be (or become)
 * connected for the session store.
 */
export function createApp(opts: CreateAppOptions = {}): Express {
  if (opts.generator) setGenerator(opts.generator);

  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(express.json({ limit: '2mb' }));

  if (!config.isProd) {
    // Dev-only CORS for the Vite dev server (credentials carry the session
    // cookie). In production this same process serves the client bundle.
    const origin = config.clientOrigin;
    app.use((req, res, next) => {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
      if (req.method === 'OPTIONS') {
        res.status(204).end();
        return;
      }
      next();
    });
  }

  app.use(
    session({
      name: 'prep.sid',
      secret: config.sessionSecret,
      resave: false,
      saveUninitialized: false,
      store: MongoStore.create({
        // Lazy: resolves once mongoose finishes connecting. Cast needed because
        // mongoose bundles its own copy of the mongodb driver types.
        clientPromise: mongoose.connection.asPromise().then((conn) => conn.getClient()) as unknown as Promise<MongoClient>,
        touchAfter: 24 * 60 * 60,
      }),
      cookie: {
        httpOnly: true,
        sameSite: 'lax',
        secure: config.isProd,
        maxAge: SESSION_COOKIE_MAX_AGE,
        path: '/',
      },
    }),
  );

  const api = express.Router();
  api.get('/health', (_req, res) => {
    res.json({ ok: true });
  });
  api.use('/auth', authRouter);
  api.use('/kits', kitsRouter);
  api.use((req, res) => {
    res.status(404).json({
      error: { code: 'NOT_FOUND', message: `Unknown API endpoint: ${req.method} ${req.path}` },
    });
  });
  app.use('/api', api);

  // Static client bundle + SPA fallback (deep links like /kits/:id).
  if (fs.existsSync(webDistDir)) {
    app.use(express.static(webDistDir));
    app.use((req, res, next) => {
      if (req.method !== 'GET' || req.path.startsWith('/api')) {
        next();
        return;
      }
      if (fs.existsSync(indexHtmlPath)) {
        res.sendFile(indexHtmlPath);
        return;
      }
      next();
    });
  }

  app.use(errorHandler);
  return app;
}

/**
 * Wire the real generator from services/pipeline lazily. Kept behind a dynamic
 * import with a non-literal specifier: the pipeline module may not exist yet
 * while it is under construction, and this file (and everything importing it)
 * must still compile and boot. Accepts the documented export shapes:
 * `generator` / `kitGenerator` instance or a `createKitGenerator()` factory.
 */
export async function wireGeneratorFromPipeline(
  log: (message: string) => void = (m) => console.warn(m),
): Promise<boolean> {
  const specifier = './services/pipeline';
  try {
    const mod = (await import(specifier)) as Record<string, unknown>;
    const factory = mod.createKitGenerator ?? mod.createGenerator;
    const candidate =
      (mod.kitGenerator as KitGenerator | undefined) ??
      (mod.generator as KitGenerator | undefined) ??
      (typeof factory === 'function' ? ((factory as () => unknown)() as KitGenerator) : undefined);
    if (
      candidate &&
      typeof candidate.run === 'function' &&
      typeof candidate.regenerate === 'function'
    ) {
      setGenerator(candidate);
      return true;
    }
    log('[api] services/pipeline did not export a usable KitGenerator (expected `generator`/`kitGenerator` or `createKitGenerator()`)');
    return false;
  } catch (err) {
    log(
      `[api] generation pipeline not wired (services/pipeline unavailable): ${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }
}

async function main(): Promise<void> {
  await connectDb();
  console.log('[api] mongo connected');
  const wired = await wireGeneratorFromPipeline();
  if (!wired) {
    console.warn(
      '[api] serving without the generation pipeline - POST /api/kits will return 503 GENERATOR_UNAVAILABLE',
    );
  }
  const app = createApp();
  const server = app.listen(config.port, () => {
    console.log(`[api] listening on http://localhost:${config.port}`);
  });
  server.on('error', (err) => {
    console.error(`[api] failed to listen on port ${config.port}:`, err);
    process.exit(1);
  });
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 3_000).unref();
    });
  }
}

function invokedDirectly(): boolean {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  const self = fileURLToPath(import.meta.url);
  const entry = path.resolve(argv1);
  return entry.toLowerCase() === self.toLowerCase();
}

if (invokedDirectly()) {
  void main().catch((err) => {
    console.error('[api] fatal startup error:', err);
    process.exit(1);
  });
}
