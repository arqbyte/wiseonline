import { validateEnv } from './env.validation';

describe('validateEnv', () => {
  const validUrl = 'postgresql://app_user:pw@localhost:5432/wiseonline';

  it('returns the config unchanged when DATABASE_URL is set', () => {
    const config = { DATABASE_URL: validUrl, PORT: '4000' };
    expect(validateEnv(config)).toBe(config);
  });

  it('throws when DATABASE_URL is missing', () => {
    expect(() => validateEnv({ PORT: '4000' })).toThrow(/DATABASE_URL/);
  });

  it('throws when DATABASE_URL is an empty / whitespace string', () => {
    expect(() => validateEnv({ DATABASE_URL: '   ' })).toThrow(/DATABASE_URL/);
  });

  it('throws when DATABASE_URL is not a string', () => {
    expect(() => validateEnv({ DATABASE_URL: 1234 })).toThrow(/DATABASE_URL/);
  });
});
