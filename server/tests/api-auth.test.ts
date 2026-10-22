// API integration tests against a real Mongo instance (the Atlas URI from the
// repo-root .env with the database name swapped to `interview_prep_test`).
// If Mongo is unreachable the whole suite skips gracefully - no mocking.
import { afterAll, describe, expect, it } from 'vitest';
import mongoose from 'mongoose';
import request from 'supertest';
import type { Express } from 'express';
import type { Response } from 'supertest';
import { Kit, inputHashFor } from '../src/models/Kit';
import { Job } from '../src/models/Job';
import type { KitDocument } from '../src/core/types';

const RUN_ID = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
const email = (n: string): string => `api-test-${RUN_ID}-${n}@example.test`;
const PASSWORD = 'correct-horse-battery';

let app: Express | undefined;
let dbReady = false;

try {
  const configMod = await import('../src/config');
  const dbMod = await import('../src/db');
  const testUri = dbMod.withDatabaseName(configMod.config.mongoUri, 'interview_prep_test');
  await dbMod.connectDb(testUri, { serverSelectionTimeoutMS: 5_000, connectTimeoutMS: 8_000 });
  const indexMod = await import('../src/index');
  app = indexMod.createApp();
  dbReady = true;
} catch (err) {
  console.warn(
    '[api-tests] Mongo test database unreachable - skipping integration tests:',
    err instanceof Error ? err.message : err,
  );
}

const d = describe.skipIf(!dbReady || !app);

function api(): Express {
  if (!app) throw new Error('app not built');
  return app;
}

function cookieOf(res: Response): string {
  const set = res.headers['set-cookie'];
  if (!set) return '';
  return (Array.isArray(set) ? set : [set]).map((c) => c.split(';')[0]).join('; ');
}

async function registerAndLogin(mail: string): Promise<{ id: string; cookie: string }> {
  const reg = await request(api())
    .post('/api/auth/register')
    .send({ email: mail, password: PASSWORD });
  expect(reg.status).toBe(201);
  const cookie = cookieOf(reg);
  expect(cookie).toContain('prep.sid=');
  return { id: reg.body.user.id as string, cookie };
}

function makeKitDoc(): KitDocument {
  return {
    source: {
      company: 'Acme Test Co',
      company_url: 'https://acme.example',
      role: 'Backend Engineer',
      location: 'Remote',
      jd_chars: 100,
      researched_at: new Date().toISOString(),
      pages_used: [],
    },
    company_brief: { summary: 'old summary', what_they_do: 'old', sources: [] },
    role: {
      title: 'Backend Engineer',
      seniority: 'Mid',
      responsibilities: ['Build APIs'],
      requirements: [
        { id: 'r1', text: 'Knows Node.js', kind: 'technical', priority: 'must' },
      ],
    },
    questions: [
      {
        id: 'q1',
        requirement_ids: ['r1'],
        category: 'technical',
        prompt: 'Explain the event loop',
        answer_outline: 'phases, microtasks',
        difficulty: 2,
        origin: 'generated',
        item_state: 'pristine',
        pinned: false,
      },
    ],
    flashcards: [
      {
        id: 'f1',
        front: 'What is Node?',
        back: 'JS runtime',
        requirement_ids: ['r1'],
        origin: 'generated',
        item_state: 'pristine',
        pinned: false,
      },
    ],
    schedule: {
      days_available: 1,
      days: [{ day: 1, focus: 'Technical practice: Knows Node.js', question_ids: ['q1'], minutes: 30 }],
    },
    coverage: { uncovered_requirement_ids: [], passes: 1 },
    warnings: [],
  };
}

async function createReadyKit(userId: string, jd: string): Promise<string> {
  const doc = await Kit.create({
    userId,
    status: 'ready',
    version: 1,
    input: {
      jd,
      companyUrl: 'https://acme.example',
      days: 3,
      inputHash: inputHashFor(jd, 'https://acme.example', 3),
    },
    kit: makeKitDoc(),
    practice: {},
  });
  return String(doc._id);
}

afterAll(async () => {
  if (dbReady) {
    try {
      await Promise.all([
        mongoose.connection.collection('users').deleteMany({}),
        mongoose.connection.collection('kits').deleteMany({}),
        mongoose.connection.collection('jobs').deleteMany({}),
        mongoose.connection.collection('sessions').deleteMany({}),
      ]);
    } catch {
      /* best effort */
    }
    try {
      await mongoose.connection.close();
    } catch {
      /* best effort */
    }
  }
});

d('health', () => {
  it('reports ok', async () => {
    const res = await request(api()).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it('returns JSON 404 for unknown API endpoints', async () => {
    const res = await request(api()).get('/api/definitely-not-a-route');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });
});

d('auth flow', () => {
  it('register -> me -> logout -> me is 401', async () => {
    const { cookie } = await registerAndLogin(email('flow'));

    const me = await request(api()).get('/api/auth/me').set('Cookie', cookie);
    expect(me.status).toBe(200);
    expect(me.body.user.email).toBe(email('flow'));
    expect(me.body.user.id).toBeTruthy();

    const logout = await request(api()).post('/api/auth/logout').set('Cookie', cookie);
    expect(logout.status).toBe(204);

    const meAfter = await request(api()).get('/api/auth/me').set('Cookie', cookie);
    expect(meAfter.status).toBe(401);
    expect(meAfter.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('rejects duplicate email with 409 EMAIL_TAKEN', async () => {
    const mail = email('dup');
    await registerAndLogin(mail);
    const res = await request(api())
      .post('/api/auth/register')
      .send({ email: mail.toUpperCase(), password: PASSWORD }); // case-insensitive
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('EMAIL_TAKEN');
  });

  it('rejects short passwords with 400 VALIDATION_ERROR', async () => {
    const res = await request(api())
      .post('/api/auth/register')
      .send({ email: email('short'), password: 'short' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(Array.isArray(res.body.error.details.fields)).toBe(true);
  });

  it('login with wrong password or unknown email is 401 INVALID_CREDENTIALS', async () => {
    const mail = email('login');
    await registerAndLogin(mail);
    const wrong = await request(api())
      .post('/api/auth/login')
      .send({ email: mail, password: 'not-the-password' });
    expect(wrong.status).toBe(401);
    expect(wrong.body.error.code).toBe('INVALID_CREDENTIALS');

    const unknown = await request(api())
      .post('/api/auth/login')
      .send({ email: email('ghost'), password: PASSWORD });
    expect(unknown.status).toBe(401);
    expect(unknown.body.error.code).toBe('INVALID_CREDENTIALS');
  });

  it('walls kit endpoints behind auth', async () => {
    const res = await request(api()).get('/api/kits');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });
});

d('kit endpoints', () => {
  it('create kit without a wired generator returns a clean 503 JSON error', async () => {
    const { cookie } = await registerAndLogin(email('nogen'));
    const res = await request(api())
      .post('/api/kits')
      .set('Cookie', cookie)
      .send({ jd: 'Hire a great engineer', companyUrl: 'https://acme.example', days: 3 });
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('GENERATOR_UNAVAILABLE');
    expect(typeof res.body.error.message).toBe('string');
    // Nothing half-created: no kit, no job.
    expect(await Kit.countDocuments({})).toBe(0);
    expect(await Job.countDocuments({})).toBe(0);
  });

  it('hides other users kits behind 404 (never 403)', async () => {
    const alice = await registerAndLogin(email('alice'));
    const bob = await registerAndLogin(email('bob'));
    const bobsKit = await createReadyKit(bob.id, 'Bobs private JD');

    const own = await request(api()).get(`/api/kits/${bobsKit}`).set('Cookie', bob.cookie);
    expect(own.status).toBe(200);

    const foreign = await request(api()).get(`/api/kits/${bobsKit}`).set('Cookie', alice.cookie);
    expect(foreign.status).toBe(404);
    expect(foreign.body.error.code).toBe('NOT_FOUND');

    const garbage = await request(api()).get('/api/kits/not-an-object-id').set('Cookie', alice.cookie);
    expect(garbage.status).toBe(404);
  });

  it('lists only own kits with the list projection', async () => {
    const alice = await registerAndLogin(email('list-alice'));
    const bob = await registerAndLogin(email('list-bob'));
    await createReadyKit(alice.id, 'Alices JD');
    await createReadyKit(bob.id, 'Bobs JD');

    const res = await request(api()).get('/api/kits').set('Cookie', alice.cookie);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({
      company: 'Acme Test Co',
      role: 'Backend Engineer',
      status: 'ready',
      days: 3,
    });
    expect(res.body[0].id).toBeTruthy();
    expect(res.body[0].createdAt).toBeTruthy();
  });

  it('PATCH with mismatched baseVersion is 409 with currentKit', async () => {
    const user = await registerAndLogin(email('conflict'));
    const kitId = await createReadyKit(user.id, 'Conflict JD');

    const res = await request(api())
      .patch(`/api/kits/${kitId}/brief`)
      .set('Cookie', user.cookie)
      .send({ summary: 'new summary', baseVersion: 99 });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('VERSION_CONFLICT');
    expect(res.body.currentKit.version).toBe(1);
    expect(res.body.currentKit.id).toBe(kitId);
  });

  it('PATCH without baseVersion applies the edit and bumps the version', async () => {
    const user = await registerAndLogin(email('edit'));
    const kitId = await createReadyKit(user.id, 'Edit JD');

    const res = await request(api())
      .patch(`/api/kits/${kitId}/brief`)
      .set('Cookie', user.cookie)
      .send({ summary: 'edited summary' });
    expect(res.status).toBe(200);
    expect(res.body.version).toBe(2);
    expect(res.body.kit.company_brief.summary).toBe('edited summary');

    // Same baseVersion cannot be replayed: it now conflicts.
    const replay = await request(api())
      .patch(`/api/kits/${kitId}/brief`)
      .set('Cookie', user.cookie)
      .send({ summary: 'replayed', baseVersion: 1 });
    expect(replay.status).toBe(409);
  });

  it('GET /kits/:id/job is 404 when the kit has no jobs', async () => {
    const user = await registerAndLogin(email('nojob'));
    const kitId = await createReadyKit(user.id, 'No job JD');
    const res = await request(api()).get(`/api/kits/${kitId}/job`).set('Cookie', user.cookie);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('DELETE removes the kit and its jobs', async () => {
    const user = await registerAndLogin(email('delete'));
    const kitId = await createReadyKit(user.id, 'Delete JD');
    await Job.create({
      kitId,
      userId: user.id,
      type: 'generate',
      status: 'completed',
      progress: [],
      checkpoints: {},
      inputHash: inputHashFor('Delete JD', 'https://acme.example', 3),
    });
    const res = await request(api()).delete(`/api/kits/${kitId}`).set('Cookie', user.cookie);
    expect(res.status).toBe(204);
    expect(await Kit.countDocuments({ _id: kitId })).toBe(0);
    expect(await Job.countDocuments({ kitId })).toBe(0);
  });
});
