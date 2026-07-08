import { Pool } from 'pg';

import { DbRoleAssertionService } from '../src/db/db-role-assertion.service';

/**
 * Machine-verifies the PRD §5 Layer 3 role model against a REAL Postgres
 * (the docker-compose stack, or the CI service). This is the card's core
 * safety property — that the runtime `app_user` connection cannot bypass or
 * defeat the RLS added in card 1.10 — which unit tests (mocked DB) cannot
 * prove.
 *
 * Requires DATABASE_URL (app_user) and MIGRATION_DATABASE_URL (migrator) to
 * point at a live DB provisioned by docker/postgres/init/01-roles.sh.
 */
const appUrl = process.env.DATABASE_URL;
const migratorUrl = process.env.MIGRATION_DATABASE_URL;
const canRun = Boolean(appUrl && migratorUrl);
const d = canRun ? describe : describe.skip;

if (!canRun) {
  console.warn(
    'Skipping db-roles integration test: set DATABASE_URL (app_user) and ' +
      'MIGRATION_DATABASE_URL (migrator) to a live Postgres to run it.',
  );
}

d('DB role isolation (PRD §5 Layer 3)', () => {
  let appPool: Pool;
  let migratorPool: Pool;
  const testTable = 'role_probe_tmp';

  beforeAll(() => {
    appPool = new Pool({ connectionString: appUrl, max: 2 });
    migratorPool = new Pool({ connectionString: migratorUrl, max: 2 });
  });

  afterAll(async () => {
    await migratorPool
      .query(`DROP TABLE IF EXISTS ${testTable}`)
      .catch(() => undefined);
    await appPool.end();
    await migratorPool.end();
  });

  it('runtime connection is app_user, NOBYPASSRLS and not a superuser', async () => {
    const { rows } = await appPool.query<{
      current_user: string;
      rolsuper: boolean;
      rolbypassrls: boolean;
    }>(
      `SELECT current_user, r.rolsuper, r.rolbypassrls
         FROM pg_roles r WHERE r.rolname = current_user`,
    );
    expect(rows[0].current_user).toBe('app_user');
    expect(rows[0].rolsuper).toBe(false);
    expect(rows[0].rolbypassrls).toBe(false);
  });

  it('app_user cannot create a table (owns nothing in public)', async () => {
    await expect(
      appPool.query(`CREATE TABLE ${testTable} (id int)`),
    ).rejects.toThrow(/permission denied/i);
  });

  it('migrator creates a table that app_user can then CRUD but not own', async () => {
    await migratorPool.query(`CREATE TABLE ${testTable} (id int primary key)`);

    // ALTER DEFAULT PRIVILEGES should have granted app_user DML on it.
    await expect(
      appPool.query(`INSERT INTO ${testTable} (id) VALUES (1)`),
    ).resolves.toBeDefined();
    await expect(appPool.query(`SELECT id FROM ${testTable}`)).resolves.toEqual(
      expect.objectContaining({ rowCount: 1 }),
    );
    await expect(
      appPool.query(`UPDATE ${testTable} SET id = 2 WHERE id = 1`),
    ).resolves.toBeDefined();
    await expect(
      appPool.query(`DELETE FROM ${testTable}`),
    ).resolves.toBeDefined();

    // …but it does not own it, so it cannot drop/alter it.
    await expect(appPool.query(`DROP TABLE ${testTable}`)).rejects.toThrow(
      /must be owner|permission denied/i,
    );
  });

  it('DbRoleAssertionService passes when connected as app_user', async () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = 'integration'; // un-skip the NODE_ENV=test guard
    try {
      const service = new DbRoleAssertionService(appPool);
      await expect(service.onApplicationBootstrap()).resolves.toBeUndefined();
    } finally {
      process.env.NODE_ENV = prev;
    }
  });
});
