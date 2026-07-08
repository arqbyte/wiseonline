import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';

import { AppModule } from '../src/app.module';

interface HealthBody {
  status: string;
  db: { ok: boolean; latencyMs?: number };
}

/**
 * End-to-end /health against a REAL Postgres — exercises the actual
 * DrizzleModule provider, pg.Pool, and `SELECT 1` round-trip via app_user
 * that the mocked controller unit test cannot reach.
 *
 * Requires DATABASE_URL to point at a live DB (docker-compose / CI service).
 */
const canRun = Boolean(process.env.DATABASE_URL);
const d = canRun ? describe : describe.skip;

d('/health (integration)', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /health → 200 with a real DB round-trip', async () => {
    const res = await request(app.getHttpServer()).get('/health');
    expect(res.status).toBe(200);
    const body = res.body as HealthBody;
    expect(body.status).toBe('ok');
    expect(body.db.ok).toBe(true);
    expect(typeof body.db.latencyMs).toBe('number');
  });

  it('GET /health/live → 200 without touching the DB', async () => {
    const res = await request(app.getHttpServer()).get('/health/live');
    expect(res.status).toBe(200);
    const body = res.body as HealthBody;
    expect(body.status).toBe('ok');
  });
});
