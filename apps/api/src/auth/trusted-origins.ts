const PLAIN_ORIGIN_RE = /^https?:\/\/[a-z0-9.-]+(:\d+)?$/i;
const WILDCARD_SUBDOMAIN_RE = /^(https?:\/\/)?\*\.[a-z0-9-]+(\.[a-z0-9-]+)+$/i;

/**
 * Parses TRUSTED_ORIGINS into Better Auth's `trustedOrigins` list, rejecting
 * entries broad enough to defeat the CSRF/origin check the card 1.2 AC
 * requires stay on. `requireEnv('TRUSTED_ORIGINS')` only guarantees the raw
 * value is non-blank — it doesn't stop someone from setting it to `*`,
 * `http://*`, or `**`, which Better Auth's wildcard matcher (see
 * better-auth/dist/utils/wildcard.mjs) would happily compile into a regex
 * matching every hostname, functionally equivalent to
 * `disableOriginCheck: true` despite that flag staying `false` (PRD §2.2,
 * "web origins only"). Only a plain `scheme://host[:port]` origin or a
 * `*.example.com`-style subdomain wildcard (with a real multi-label base
 * domain) is accepted.
 */
export function parseTrustedOrigins(raw: string): string[] {
  const origins = raw
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  if (origins.length === 0) {
    throw new Error(
      'TRUSTED_ORIGINS resolved to zero origins after parsing — Better Auth ' +
        'would then trust nothing but its own BETTER_AUTH_URL, breaking ' +
        'every client. Set at least one origin.',
    );
  }

  for (const origin of origins) {
    const isValid =
      PLAIN_ORIGIN_RE.test(origin) || WILDCARD_SUBDOMAIN_RE.test(origin);
    if (!isValid) {
      throw new Error(
        `TRUSTED_ORIGINS entry "${origin}" is not a well-formed web origin ` +
          'or is a wildcard broad enough to match any host (e.g. "*", ' +
          '"http://*"). Use an exact "scheme://host[:port]" origin or a ' +
          '"*.example.com"-style subdomain wildcard.',
      );
    }
  }

  return origins;
}
