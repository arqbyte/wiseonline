import { parseTrustedOrigins } from './trusted-origins';

describe('parseTrustedOrigins', () => {
  it('parses a single plain origin', () => {
    expect(parseTrustedOrigins('http://localhost:3000')).toEqual([
      'http://localhost:3000',
    ]);
  });

  it('trims whitespace and drops empty entries between commas', () => {
    expect(
      parseTrustedOrigins(
        ' http://localhost:3000 , https://app.wiseonline.com ,',
      ),
    ).toEqual(['http://localhost:3000', 'https://app.wiseonline.com']);
  });

  it('accepts a *.example.com-style subdomain wildcard, with or without a scheme', () => {
    expect(parseTrustedOrigins('*.wiseonline.com')).toEqual([
      '*.wiseonline.com',
    ]);
    expect(parseTrustedOrigins('https://*.wiseonline.com')).toEqual([
      'https://*.wiseonline.com',
    ]);
  });

  it('throws when the value resolves to zero origins', () => {
    expect(() => parseTrustedOrigins('')).toThrow(/resolved to zero origins/);
    expect(() => parseTrustedOrigins(' , , ')).toThrow(
      /resolved to zero origins/,
    );
  });

  it.each(['*', 'http://*', 'https://*', '**', '*://*'])(
    'rejects the overbroad wildcard "%s"',
    (wildcard) => {
      expect(() => parseTrustedOrigins(wildcard)).toThrow(
        /not a well-formed web origin/,
      );
    },
  );

  it('rejects a malformed entry mixed in with valid ones', () => {
    expect(() =>
      parseTrustedOrigins('http://localhost:3000,not-a-url'),
    ).toThrow(/"not-a-url"/);
  });
});
