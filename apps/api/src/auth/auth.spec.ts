/**
 * Unit-level coverage for auth.ts's fail-fast env reads (unit lane, no DB —
 * `pg.Pool` connects lazily so constructing it here never opens a socket).
 * HTTP-level behavior (sign-up/sign-in/sign-out, trustedOrigins) is covered
 * by auth.e2e-spec.ts and auth.integration-spec.ts.
 *
 * Reloaded via `require` + `jest.resetModules()` (not dynamic `import()`,
 * which needs --experimental-vm-modules under this project's CommonJS ts-jest
 * transform) so each case re-runs auth.ts's module-level env checks fresh.
 *
 * dotenv/config is mocked out: auth.ts's `import 'dotenv/config'` would
 * otherwise re-read the real apps/api/.env on every reset, silently
 * backfilling a var this suite just deleted to simulate it being unset.
 */
jest.mock('dotenv/config', () => ({}));

function loadAuthModule(): unknown {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- see block comment above
  return require('./auth');
}

const REQUIRED_ENV = {
  DATABASE_URL: 'postgresql://app_user:x@localhost:5432/wiseonline_test',
  BETTER_AUTH_SECRET: 'unit-test-secret-not-for-real-use-min-32-characters',
  BETTER_AUTH_URL: 'http://localhost:4000',
  TRUSTED_ORIGINS: 'http://localhost:3000',
} as const;

type RequiredEnvKey = keyof typeof REQUIRED_ENV;

describe('auth config (unit)', () => {
  const originalEnv: Partial<Record<RequiredEnvKey, string | undefined>> = {};

  beforeEach(() => {
    jest.resetModules();
    for (const key of Object.keys(REQUIRED_ENV) as RequiredEnvKey[]) {
      originalEnv[key] = process.env[key];
      process.env[key] = REQUIRED_ENV[key];
    }
  });

  afterEach(() => {
    for (const key of Object.keys(REQUIRED_ENV) as RequiredEnvKey[]) {
      if (originalEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = originalEnv[key];
      }
    }
  });

  it('builds successfully when every required env var is set', () => {
    expect(loadAuthModule()).toHaveProperty('auth');
  });

  it.each(Object.keys(REQUIRED_ENV) as RequiredEnvKey[])(
    'fails fast with a clear error when %s is missing',
    (missingKey) => {
      delete process.env[missingKey];
      expect(() => loadAuthModule()).toThrow(
        new RegExp(`${missingKey} is not set`),
      );
    },
  );

  it.each(Object.keys(REQUIRED_ENV) as RequiredEnvKey[])(
    'fails fast when %s is only whitespace',
    (blankKey) => {
      process.env[blankKey] = '   ';
      expect(() => loadAuthModule()).toThrow(
        new RegExp(`${blankKey} is not set`),
      );
    },
  );

  it('fails fast when BETTER_AUTH_SECRET is shorter than 32 characters', () => {
    process.env.BETTER_AUTH_SECRET = 'too-short';
    expect(() => loadAuthModule()).toThrow(/shorter than 32 characters/);
  });

  it.each(['*', 'http://*', '**', '*://*'])(
    'fails fast when TRUSTED_ORIGINS is the overbroad wildcard "%s"',
    (wildcard) => {
      process.env.TRUSTED_ORIGINS = wildcard;
      expect(() => loadAuthModule()).toThrow(/not a well-formed web origin/);
    },
  );

  it('fails fast when TRUSTED_ORIGINS resolves to zero origins after parsing', () => {
    process.env.TRUSTED_ORIGINS = ' , , ';
    expect(() => loadAuthModule()).toThrow(/resolved to zero origins/);
  });

  it('accepts a scoped subdomain wildcard', () => {
    process.env.TRUSTED_ORIGINS = 'https://*.wiseonline.com';
    expect(loadAuthModule()).toHaveProperty('auth');
  });
});
