import type { NestExpressApplication } from '@nestjs/platform-express';
import { Pool } from 'pg';
import request from 'supertest';

import { createApp } from '../src/create-app';

interface AuthUser {
  id: string;
  email: string;
  emailVerified: boolean;
}

interface SignUpResponse {
  token: string | null;
  user: AuthUser;
}

interface SignInResponse {
  token: string;
  user: AuthUser;
}

interface AuthErrorBody {
  code: string;
  message: string;
}

interface SignOutResponse {
  success: boolean;
}

/**
 * Full auth-core flow against a REAL Postgres — sign-up/sign-in/sign-out
 * over HTTP, and that an unverified user cannot sign in (card 1.2 AC).
 * "Verifying" the test user updates the DB row directly: the mailer that
 * actually sends verification emails is card 1.4, not this one.
 *
 * Requires DATABASE_URL + BETTER_AUTH_SECRET + BETTER_AUTH_URL +
 * TRUSTED_ORIGINS pointed at a live Postgres (docker-compose / CI service).
 */
const canRun = Boolean(
  process.env.DATABASE_URL &&
  process.env.BETTER_AUTH_SECRET &&
  process.env.BETTER_AUTH_URL &&
  process.env.TRUSTED_ORIGINS,
);
const d = canRun ? describe : describe.skip;

if (!canRun) {
  console.warn(
    'Skipping auth integration test: set DATABASE_URL, BETTER_AUTH_SECRET, ' +
      'BETTER_AUTH_URL and TRUSTED_ORIGINS to a live Postgres to run it.',
  );
}

d('Auth core (integration)', () => {
  let app: NestExpressApplication;
  let verificationPool: Pool;
  const testEmail = `auth-integration-${Date.now()}@example.com`;
  const testPassword = 'correct horse battery staple';
  const trustedOrigin = (process.env.TRUSTED_ORIGINS ?? '')
    .split(',')[0]
    .trim();

  beforeAll(async () => {
    app = await createApp();
    await app.init();
    verificationPool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 1,
    });
  });

  afterAll(async () => {
    await verificationPool
      .query('DELETE FROM "user" WHERE email = $1', [testEmail])
      .catch(() => undefined);
    await verificationPool.end();
    await app.close();
  });

  it('signs up a new user as unverified, with no session token', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/auth/sign-up/email')
      .set('Origin', trustedOrigin)
      .send({
        email: testEmail,
        password: testPassword,
        name: 'Auth Integration',
      });

    expect(res.status).toBe(200);
    const body = res.body as SignUpResponse;
    expect(body.user.emailVerified).toBe(false);
    expect(body.token).toBeNull();
  });

  it('blocks sign-in for the unverified account', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/auth/sign-in/email')
      .set('Origin', trustedOrigin)
      .send({ email: testEmail, password: testPassword });

    expect(res.status).toBe(403);
    const body = res.body as AuthErrorBody;
    expect(body.code).toBe('EMAIL_NOT_VERIFIED');
  });

  it('signs in once verified, then sign-out revokes the session', async () => {
    await verificationPool.query(
      'UPDATE "user" SET email_verified = true WHERE email = $1',
      [testEmail],
    );

    const signInRes = await request(app.getHttpServer())
      .post('/api/auth/sign-in/email')
      .set('Origin', trustedOrigin)
      .send({ email: testEmail, password: testPassword });

    expect(signInRes.status).toBe(200);
    const signInBody = signInRes.body as SignInResponse;
    expect(signInBody.user.emailVerified).toBe(true);
    expect(typeof signInBody.token).toBe('string');

    const rawSetCookie: unknown = signInRes.headers['set-cookie'];
    const setCookieHeaders = Array.isArray(rawSetCookie)
      ? (rawSetCookie as string[])
      : [String(rawSetCookie)];
    const sessionCookie = setCookieHeaders.find((cookie) =>
      cookie.startsWith('better-auth.session_token='),
    );
    expect(sessionCookie).toBeDefined();
    expect(sessionCookie).toMatch(/HttpOnly/);
    expect(sessionCookie).toMatch(/SameSite=Lax/);

    const signOutRes = await request(app.getHttpServer())
      .post('/api/auth/sign-out')
      .set('Origin', trustedOrigin)
      .set('Cookie', (sessionCookie ?? '').split(';')[0]);

    expect(signOutRes.status).toBe(200);
    const signOutBody = signOutRes.body as SignOutResponse;
    expect(signOutBody.success).toBe(true);
  });

  it('rejects a too-short password with a validation error, not a 500', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/auth/sign-up/email')
      .set('Origin', trustedOrigin)
      .send({
        email: `auth-integration-short-pw-${Date.now()}@example.com`,
        password: 'short',
        name: 'Too Short',
      });

    expect(res.status).toBe(400);
  });
});
