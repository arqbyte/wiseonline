import { createAuthClient } from "better-auth/react";

/**
 * No `baseURL`: the API is reverse-proxied onto this app's own origin at
 * `/api/*` (see next.config.ts `rewrites`, dev and prod alike — PRD §2.2),
 * so requests are always same-origin and the session cookie needs no
 * cross-site/CORS handling.
 */
export const authClient = createAuthClient();

export const { useSession, signIn, signUp, signOut } = authClient;
