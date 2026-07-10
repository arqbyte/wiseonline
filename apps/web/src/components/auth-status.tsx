"use client";

import { signOut, useSession } from "@/lib/auth-client";

/**
 * Minimal session indicator proving useSession()/signOut() are wired
 * end-to-end (card 1.3 AC). Full auth UI (login/register/forgot/reset
 * pages) is card 1.7 — this is not that.
 */
export function AuthStatus() {
  const { data: session, isPending } = useSession();

  if (isPending) {
    return <span className="text-sm text-zinc-500">Loading session…</span>;
  }

  if (!session) {
    return <span className="text-sm text-zinc-500">Signed out</span>;
  }

  return (
    <div className="flex items-center gap-3 text-sm">
      <span>Signed in as {session.user.email}</span>
      <button
        type="button"
        onClick={() => signOut()}
        className="underline underline-offset-2"
      >
        Sign out
      </button>
    </div>
  );
}
