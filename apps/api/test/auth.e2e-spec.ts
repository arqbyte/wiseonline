import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';

import { createApp } from '../src/create-app';

interface AuthErrorBody {
  code: string;
  message: string;
}

interface AuthOkBody {
  ok: boolean;
}

/**
 * DB-free auth coverage: mounting/wiring and the origin/CSRF guard, both of
 * which fire before any DB access. Uses createApp() (not
 * Test.createTestingModule) so the exact production HTTP wiring — Better
 * Auth mounted ahead of the body parser — is what's under test. Stateful
 * flows (sign-up/sign-in/sign-out) need a real DB and live in
 * auth.integration-spec.ts.
 */
describe('Auth core (e2e, DB-free)', () => {
  let app: NestExpressApplication;

  beforeAll(async () => {
    app = await createApp();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /api/auth/ok confirms the handler is mounted', async () => {
    // Better Auth's own built-in handshake route — its body is `{ ok: true }`
    // (verified against the installed package), not the `{ status: "ok" }`
    // shape AUTH_KANBAN.md's card 1.2 AC describes. Asserted here so that
    // discrepancy is a visible, intentional call-out rather than silent.
    const res = await request(app.getHttpServer()).get('/api/auth/ok');
    expect(res.status).toBe(200);
    const body = res.body as AuthOkBody;
    expect(body.ok).toBe(true);
  });

  it('rejects a sign-in from an untrusted origin (CSRF/origin check is not disabled)', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/auth/sign-in/email')
      .set('Origin', 'http://evil.example.com')
      .send({ email: 'nobody@example.com', password: 'irrelevant-password' });

    expect(res.status).toBe(403);
    const body = res.body as AuthErrorBody;
    expect(body.code).toBe('INVALID_ORIGIN');
  });

  it('non-auth routes are unaffected by the disabled global body-parser', async () => {
    // No non-auth route in this API accepts a body yet, so this can't
    // positively assert JSON *parsing* succeeded — only that re-registering
    // json()/urlencoded() after the Better Auth mount (create-app.ts) didn't
    // leave the rest of the app hanging or crashing on a JSON POST. Nest's
    // normal 404 for an unmapped route is what a healthy, unaffected app
    // returns here.
    const res = await request(app.getHttpServer())
      .post('/definitely-not-a-mapped-route')
      .send({ a: 1 });

    expect(res.status).toBe(404);
  });
});
