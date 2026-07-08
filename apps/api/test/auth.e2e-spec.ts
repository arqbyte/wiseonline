import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';

import { createApp } from '../src/create-app';

interface AuthErrorBody {
  code: string;
  message: string;
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
    const res = await request(app.getHttpServer()).get('/api/auth/ok');
    expect(res.status).toBe(200);
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

  it('still parses JSON bodies for non-auth routes (bodyParser:false is scoped to /api/auth)', async () => {
    const res = await request(app.getHttpServer())
      .post('/definitely-not-a-mapped-route')
      .send({ a: 1 });

    // Nest's normal 404 for an unmapped route, not a hung request or an
    // unhandled body-parsing crash.
    expect(res.status).toBe(404);
  });
});
