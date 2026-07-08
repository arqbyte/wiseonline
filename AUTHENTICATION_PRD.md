# PRD: Authentication, Identity & Multi-Tenant Security

**Product:** wiseonline — device & asset tracking for startups and SMBs
**Stack:** Better Auth (TypeScript) · NestJS API (`apps/api`) · Next.js App Router web (`apps/web`) · PostgreSQL (Drizzle)
**Status:** Draft v1.2 — merges `AUTHENTICATION_SPEC_1.md` and `AUTHENTICATION_SPEC_2.md`, corrected against Better Auth's actual API surface; v1.1 adds the single-organization-per-user invariant and edge cases EC-17…EC-28; v1.2 folds in the pre-implementation security review (EC-29…EC-33 + spec corrections)
**Last updated:** 2026-07-07

---

## 1. Overview

wiseonline is multi-tenant: each customer company is an **organization**; all operational data (assets, employees, return logs) is isolated by `organization_id`. Auth must serve two very different customers with one system:

- **Founders/SMBs (day 1):** sign up with email/password or Google/Microsoft, create a workspace in under a minute, invite 2–10 teammates.
- **Enterprise IT (later):** SAML/OIDC SSO, SCIM provisioning/deprovisioning, enforced MFA, audit logs, domain capture.

### Goals
1. Zero cross-tenant data leakage — enforced in middleware **and** at the database (RLS), never trusting client-supplied tenant identifiers.
2. Self-serve onboarding that gracefully handles the "invited user signs up on their own first" collision.
3. Enterprise identity lifecycle: SSO enforcement, SCIM sync, deprovisioning that triggers the asset-return workflow.
4. Lean on Better Auth's maintained plugins (organization, sso, two-factor, api-key, admin) instead of hand-rolled tables wherever possible.

### Non-goals (v1)
- Passkeys/WebAuthn (fast-follow; Better Auth `passkey` plugin makes this cheap later).
- Fine-grained ABAC. We ship RBAC with org-customizable roles; attribute conditions come later.
- Self-hosted/on-prem deployments.
- Cross-organization asset transfers.
- **Multi-org membership** — see the core invariant below.

### Core invariant — one organization per user (product rule)

**A user belongs to exactly one organization at a time.** They cannot be a member of a second workspace while a member of one; once in, they are "locked in" to that org until they leave it or it is deleted. This is a deliberate product decision, not a limitation — it keeps the mental model, billing (seat = user = one org), and the UI (no workspace switcher) simple for the founder/SMB audience.

Consequences that ripple through this PRD:
- Org **creation** is allowed only for users with **zero** memberships (this reverses an earlier "correction" — spec 1's zero-membership rule was right for our model; see §6.1).
- An **invitation**, **domain auto-join**, or **SCIM/SSO provisioning** that targets a user who is *already* a member of some org is **rejected and flagged**, never silently added-to or moved (the boundary edge case — EC-17).
- On login the user's single membership deterministically becomes the active org; `activeOrganizationId` is effectively a fixed pointer, not a user choice.
- Leaving (or being removed from) your only org returns you to the onboarding limbo state (org-less), from which you may then create or accept a new one. "Locked in" means *while a member*, not *forever* (§6.6, EC-27).

**"Still do the mitigation."** Even though the product permits only one org per user, we retain the full multi-tenant isolation machinery — per-request membership re-verification, RLS, org-scoped session revocation, per-request org binding — as **defense-in-depth**. The invariant is enforced at the application layer *and* backstopped by a DB constraint (§3.2); the isolation layers exist so that a bug or attacker that manages to create a second membership or a foreign-org pointer still cannot read or write across the boundary.

---

## 2. Architecture

### 2.1 Topology

```
Browser ── app.wiseonline.com ──► Next.js (apps/web)   UI only; no auth logic beyond client SDK
                │
                └─ api.wiseonline.com ──► NestJS (apps/api)
                                             ├─ Better Auth handler mounted at /api/auth/*
                                             ├─ AuthGuard + OrgGuard (tenant isolation)
                                             ├─ Domain controllers (assets, employees, returns…)
                                             └─ SCIM controllers at /scim/v2/* (custom, see §8)
PostgreSQL: Better Auth tables + app tables, RLS on all tenant tables
Redis (secondaryStorage): session lookups + rate-limit counters
```

- Better Auth runs **inside NestJS** (single source of truth for identity). Mount the handler on the underlying Express/Fastify adapter (`toNodeHandler(auth)`) with NestJS body-parsing disabled for that route subtree, or use the community `@thallesp/nestjs-better-auth` module. Next.js does **not** run its own Better Auth instance; it uses `createAuthClient` pointed at the API.
- The Next.js server components may read the session by forwarding cookies to `auth.api.getSession` over the internal network — but must never make authorization decisions the API doesn't re-check. **Zero trust between client and backend.**

### 2.2 Cookies across two apps ⚠️ (unaddressed in both source specs)

The web app and API are separate origins. Session cookies are set by the API. Requirements:

- **Production (v1.2 preference — same-host path routing):** serve the web app at `app.wiseonline.com` and reverse-proxy `app.wiseonline.com/api/*` to the API, so the session cookie needs **no `Domain=` attribute at all** and can use the `__Host-` prefix (host-locked, `Secure`, path `/`) — the strongest cookie posture. A `Domain=.wiseonline.com` cross-subdomain cookie is the fallback (`advanced.crossSubDomainCookies`), but it is readable by *every* subdomain: one dangling-DNS subdomain takeover exposes sessions, so choosing it commits us to a strict subdomain inventory and no third-party-hosted subdomains. Either way, third-party-cookie blocking makes a fully cross-site cookie architecture a dead end — do not ship `SameSite=None` across unrelated domains.
- **Development:** proxy `/api/auth/*` (and API calls generally) through Next.js `rewrites` to `localhost:4000` so the browser sees a single origin, or run both on `localhost` different ports (same-site) and set `trustedOrigins: ["http://localhost:3000"]`.
- `trustedOrigins` is the CSRF/origin allowlist — keep it to exactly the web origins. Never set `disableCSRFCheck` or `disableOriginCheck`.
- All OAuth/SSO `callbackURL` values must be validated against `trustedOrigins` (Better Auth default behavior — do not weaken it). This is the open-redirect guard.

### 2.3 Session storage

- Redis as `secondaryStorage` with `storeSessionInDatabase: true` (DB rows power the "Active sessions" UI in Account Settings; Redis powers fast lookups).
- **Cookie cache:** if enabled, revocation is delayed until the cache expires. Cap `session.cookieCache.maxAge` at 5 minutes, and bump `cookieCache.version` for emergency global logout. Security-sensitive checks (org membership, role) are re-read from DB by the guards regardless (custom session fields are never trusted from the cached cookie).

---

## 3. Data model

### 3.1 Better Auth managed tables (do not hand-design these)

`user`, `session`, `account`, `verification` — core. Plugins add: `organization`, `member`, `invitation` (+ `team` if enabled), `twoFactor`, `apikey`, `ssoProvider`, and the dynamic-access-control role tables. Schema comes from `npx @better-auth/cli generate` against the Drizzle schema — **re-run after every plugin change**. The SQL in spec 1 is illustrative only; the CLI output is authoritative.

Key columns we rely on:
- `session.activeOrganizationId` — the org context for the current session (set via `organization.setActive`; **verified server-side on every request**, see §5). Under the single-org invariant this is a fixed pointer to the user's one membership, set automatically at login — not a switchable selection.
- `account.providerId` ∈ `credential | google | microsoft | sso:<provider>` — used for SSO-enforcement checks.
- `user.emailVerified` — gate for invitations, SCIM linking, and account linking.

**Single-org DB backstop (the "mitigation"):** the `member` table is Better Auth-managed, but we add a **unique index enforcing at most one membership per user** via migration — this is the last line of defense for the core invariant, independent of any application-layer check:
```sql
-- At most one membership per user. Memberships are HARD-deleted on exit
-- (Better Auth's organization plugin removes the row; there is no deleted_at
-- column), so a plain unique index is correct and frees the slot for a re-hire.
CREATE UNIQUE INDEX one_org_per_user ON "member" (user_id);
```
Any code path (invite accept, SCIM create, domain join) that would create a second membership row hits this constraint and fails loudly rather than corrupting state.

**v1.2 lifecycle decision:** earlier drafts mixed "remove the member row" (§6.6) with "soft-remove via `deleted_at`" (§8.3). Resolved: **membership exits are hard deletes**, matching the plugin's own behavior. Deprovision/leave/removal *history* lives in `audit_logs` (and the SCIM delivery log) — not in tombstone member rows.

Corrections vs the source specs:
- ❌ Spec 1 configures `organization({ roles: [...], defaultRole })`. That is not the plugin's API. Roles are defined with `createAccessControl` statements + `roles` maps, and org-specific custom roles use `dynamicAccessControl: { enabled: true }` (this is what powers the "customize permissions per role" screen already designed in Figma).
- ❌ Spec 2's hand-rolled `roles` / `permissions` / `role_permissions` tables → replaced by the plugin's access control + dynamic AC storage.
- ❌ Spec 2's `mfa_factors` table → replaced by the `twoFactor` plugin (TOTP secrets stored **encrypted**, backup codes **hashed** — never plaintext columns).
- ❌ Spec 2's `api_keys` table → replaced by the `apiKey` plugin (hashed keys, expiry, per-key rate limits, metadata for scopes).

### 3.2 App-owned tables

```sql
-- Org security & tenant policy (1:1 with organization)
CREATE TABLE organization_settings (
  organization_id     TEXT PRIMARY KEY REFERENCES organization(id) ON DELETE CASCADE,
  enforce_sso         BOOLEAN NOT NULL DEFAULT FALSE,
  allow_email_login   BOOLEAN NOT NULL DEFAULT TRUE,
  mfa_required        BOOLEAN NOT NULL DEFAULT FALSE,
  session_timeout_minutes INTEGER NOT NULL DEFAULT 10080,  -- 7 days
  auto_join_enabled   BOOLEAN NOT NULL DEFAULT FALSE,      -- domain capture is opt-in
  auto_join_role      TEXT NOT NULL DEFAULT 'viewer',
  scim_enabled        BOOLEAN NOT NULL DEFAULT FALSE,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Domain capture (DNS-TXT verified; NOT globally unique by accident — see EC-9)
CREATE TABLE verified_domains (
  id               TEXT PRIMARY KEY,
  organization_id  TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  domain           TEXT NOT NULL,               -- lowercased, punycode-normalized
  verification_txt TEXT NOT NULL,               -- expected DNS TXT value
  verified_at      TIMESTAMPTZ,
  last_checked_at  TIMESTAMPTZ,                 -- periodic re-verification (EC-31)
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
  -- v1.2: NO plain UNIQUE(domain) constraint — it would block a second org from
  -- even ATTEMPTING verification of a contested domain, contradicting EC-9's
  -- dispute resolution. Uniqueness applies to VERIFIED rows only:
);
CREATE UNIQUE INDEX verified_domain_unique ON verified_domains (domain) WHERE verified_at IS NOT NULL;

-- SCIM credentials (one bearer token per org directory)
CREATE TABLE scim_tokens (
  id               TEXT PRIMARY KEY,
  organization_id  TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  hashed_token     TEXT NOT NULL,
  last_used_at     TIMESTAMPTZ,
  expires_at       TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Append-only audit trail
CREATE TABLE audit_logs (
  id               TEXT PRIMARY KEY,
  organization_id  TEXT,            -- v1.2: NULLABLE — login success/failure, signup,
                                    -- and limbo-user events have no org; NOT NULL here
                                    -- would force implementers to fabricate an org id
                                    -- or silently skip pre-org auth logging (EC-19 visibility)
  actor_user_id    TEXT,            -- NULL for system/SCIM actions
  actor_type       TEXT NOT NULL DEFAULT 'user',  -- user | api_key | scim | system | impersonation
  action           TEXT NOT NULL,   -- e.g. 'member.role_changed'
  resource_type    TEXT,
  resource_id      TEXT,
  ip_address       TEXT,
  user_agent       TEXT,
  metadata         JSONB,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- App DB role gets INSERT + SELECT only. No UPDATE/DELETE grants. (§10)

-- Operational tables (employees, assets) as in spec 1, unchanged, all with
-- organization_id NOT NULL REFERENCES organization(id).
```

**Email normalization (both specs miss this):** all email comparisons — signup uniqueness, invitation matching, SCIM matching, domain extraction — operate on `lower(trim(email))`. Use `citext` or expression indexes. Gmail dot/plus-addressing variants are *not* collapsed (they are distinct mailboxes per RFC), but invitation matching must be case-insensitive.

### 3.3 `employees` vs `user` — two different concepts (needs explicit statement)

An **employee** is an asset-holder record in the tenant's directory (may never log in — e.g. a contractor who receives a laptop). A **user/member** is a login identity. They may share an email but are never FK-linked in v1. Offboarding an employee (asset return) and deprovisioning a member (access removal) are separate flows that SCIM deprovisioning triggers **together** when the emails match (§8.3).

---

## 4. Authentication methods & flows

### 4.1 Methods
| Method | Mechanism | Notes |
|---|---|---|
| Email + password | Better Auth `emailAndPassword`, scrypt | `requireEmailVerification: true` |
| Google OAuth | `socialProviders.google` | request `email`, `profile` |
| Microsoft OAuth | `socialProviders.microsoft` | multi-tenant Entra app |
| SAML 2.0 / OIDC SSO | `@better-auth/sso` plugin | per-org providers, registered via IdP Setup modal (already designed) |
| API keys | `apiKey` plugin | machine access, org-scoped via key metadata |
| SCIM bearer token | custom (§8) | provisioning only, never a login method |

### 4.2 Sign-up & verification (FR-1)
1. Email/password signup requires name + email; verification email sent on signup; unverified users cannot sign in (`requireEmailVerification`).
2. Signup response is identical whether or not the email already exists (anti-enumeration). The "email exists" path silently sends a "you already have an account" email instead.
3. Password policy: min 12 chars; checked against breached-password list (Better Auth `haveIBeenPwned` plugin). No composition rules, no forced rotation (NIST 800-63B).
4. OAuth signup: trust `email_verified` **only from Google and Microsoft**. Any future generic OAuth provider defaults to unverified → forces verification email.

### 4.3 Sign-in (FR-2)
1. Rate-limited on a **combined IP + account** key (Better Auth `rateLimit` on `/sign-in/*`, storage = Redis) with progressive backoff; no hard CAPTCHA in v1 but the `captcha` plugin is the escalation path. ⚠️ A *bare per-account* counter is itself a weapon — an attacker floods failed logins for `victim@x.com` to lock the real user out (**EC-19**). Mitigation: throttle primarily by IP, apply account-level throttle only after IP-level abuse, and never escalate a legitimate user into a hard lock from attacker-sourced attempts (surface a step-up/CAPTCHA instead of a block). A **trusted-device cookie** from a prior successful login *softens* the account-level limits — it never fully exempts, because a stolen cookie would otherwise be an unlimited-guessing token; the cookie is bound to the specific account and rotated on every successful login (v1.2).
2. Failed-login responses are uniform ("invalid email or password") regardless of which part failed and of whether the account exists.
3. If the user's only account row is an SSO account, the password form returns a directed error: "Your organization uses SSO — continue with SSO." (Only after the email is known to be SSO-managed via domain match — do not leak account existence otherwise.)
4. **SSO enforcement is evaluated against the user's org on every request, not just at login** (see EC-2): if the user's single org has `enforce_sso = true`, the session's auth method must be that org's SSO provider or the OrgGuard rejects it (and enable-time revocation kills existing non-SSO sessions). Under the single-org invariant there is no "activate a different org" path, but the check still runs per request as defense-in-depth.

### 4.4 Session rules (FR-3)
- Absolute expiry 7 days (`session.expiresIn`), sliding refresh 1 day (`session.updateAge`).
- Org-level override: `session_timeout_minutes` from `organization_settings` enforced by the OrgGuard. **v1.2 semantics — absolute session-age cap:** measured against `session.createdAt`; a session older than the cap is rejected for org resources even if globally valid, forcing re-login. Validated bounds: 15 minutes to 43,200 (30 days); the global 7-day `expiresIn` still applies on top. This is deliberately *not* an idle timeout — idle semantics need per-request activity tracking the session model doesn't provide (sliding refresh touches `updatedAt` at most daily), and leaving it ambiguous invites the weakest implementation. Idle timeout is backlog.
- **Freshness for sensitive actions:** `session.freshAge = 15 * 60`. Endpoints tagged `@RequiresFreshSession()` (role changes, SSO/SCIM config, API key creation, billing, workspace deletion, data export) return `401 SECURITY_CHALLENGE_REQUIRED` when stale; web re-prompts for password/SSO/MFA and retries. Note: Better Auth freshness gates its own endpoints (e.g. delete user); our domain endpoints enforce the same check in the guard.
- **SSO step-up must force IdP re-authentication (EC-30):** for SSO-authenticated sessions, a still-valid IdP cookie completes the "re-auth" redirect **silently** — turning step-up into a rubber stamp on exactly the shared machine EC-4 targets. The step-up flow therefore sends `ForceAuthn="true"` (SAML) / `prompt=login` + `max_age=0` (OIDC), and rejects assertions whose auth-instant predates the challenge. If the IdP ignores forced re-auth, fall back to our TOTP.
- Session rotation: on password change, MFA enrollment, and email change → revoke all other sessions (`revokeOtherSessions`).
- Device management UI (Account Settings → Sessions, already designed): list sessions with IP + user agent, revoke one, revoke all.

### 4.5 Account linking (FR-4)
- `account.accountLinking.enabled: true` with `trustedProviders: ["google", "microsoft"]` and **email-verified requirement**. A verified Google login with the same verified email links to the existing user; anything else creates a conflict requiring the user to sign in with the original method and link manually from Account Settings.
- Never auto-link when either side is unverified (hijack vector — EC-2).

### 4.6 Email change / password reset (FR-5)
- Password reset: token TTL 1 hour, single-use, uniform response whether the email exists. Resetting a password does **not** bypass `enforce_sso` (an SSO-enforced member cannot mint a usable credential login for that org — they can hold a password for other orgs, but the org gate in 4.3/4.4 still blocks it).
- Email change uses Better Auth's two-step flow (confirm from the *current* address first). Email change re-fires invitation/domain matching logic and drops SCIM linkage flags if the new email leaves a managed domain (flag to org admins).

---

## 5. Multi-tenant isolation (FR-6) — defense in depth

**Layer 1 — Guards (NestJS):** every protected route passes `AuthGuard` (valid session) then `OrgGuard`:
1. Read `activeOrganizationId` from the session.
2. If absent → `403 { code: "NO_ACTIVE_WORKSPACE" }`. ❌ *Spec 1 returned HTTP 200 with a limbo payload from middleware — wrong: a data endpoint must never 200 without data. The limbo state is a client routing concern driven by this 403 code (or by the dedicated onboarding endpoints in §6).*
3. Re-verify membership: `member` row for (userId, activeOrgId) must exist **on every request** — the session's cached org id is a hint, never an authorization. Attach `{ userId, organizationId, role, permissions }` to the request.
4. **Per-request org binding (EC-18):** if the request carries an explicit org identifier (org-scoped URL path segment or header) it must equal the session's resolved org; a mismatch → `403 { code: "ORG_CONTEXT_MISMATCH" }`. Under the single-org invariant a user has exactly one destination org, so this can only fire on a bug or an attack — but binding the org per request (rather than trusting session state alone) is the defense against stale-tab / race misrouting a write into the wrong workspace. Every write additionally re-derives `organizationId` from the authenticated context, never from client-supplied body fields.
5. Enforce org policy: SSO enforcement (4.3), MFA requirement (§9), org session timeout.
6. **Impersonation gate:** if the session is a support-impersonation session, block any endpoint tagged `@RequiresFreshSession()` or otherwise destructive (EC-23, §10.5) — impersonators may observe, not perform sensitive mutations.

**Layer 2 — Repository discipline:** all queries on tenant tables are built through a tenant-scoped repository that injects `WHERE organization_id = ctx.organizationId`. No raw cross-tenant joins. Lint rule/code review gate: direct table access outside the repository layer fails CI.

**Layer 3 — Postgres RLS (mandatory):**
```sql
ALTER TABLE assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE assets FORCE ROW LEVEL SECURITY;   -- applies to table owner too
CREATE POLICY tenant_isolation ON assets
  USING (organization_id = current_setting('app.current_org', true));
```
- Every request's DB work runs in a transaction that first executes `SET LOCAL app.current_org = $orgId` (Drizzle transaction wrapper). `SET LOCAL` (not `SET`) — ⚠️ **pooled connections otherwise leak the setting across tenants**; with PgBouncer this requires transaction pooling mode and no session-level SET.
- The API connects as a dedicated role with `NOBYPASSRLS` and no ownership of tenant tables. Migrations run as a separate role.
- **Fail closed (EC-22):** the policy must deny when `app.current_org` is unset. `current_setting('app.current_org', true)` returns `NULL` when missing and `organization_id = NULL` is never true, so a transaction that forgot to `SET LOCAL` sees **zero rows** — the safe default. This is a load-bearing property: never "fix" a missing-setting error by defaulting the GUC to `''`, and never write the policy with `COALESCE(current_setting(...), organization_id)` or any construct that turns unset into match-all. A required test asserts that a query with no setting returns zero rows.
- Background jobs (BullMQ) receive `organizationId` in the payload and open the same scoped transaction. Global maintenance jobs use an explicitly named `service_role` and are individually security-reviewed.

---

## 6. Organizations, onboarding & invitations

### 6.1 Workspace creation (FR-7) — maps to the Figma "Workspace Setup" screen
- After first login with no membership, the user lands on Workspace Setup: create a workspace **or** wait for an invitation (the screen already shows the invite-watcher affordance).
- `allowUserToCreateOrganization`: **only users with zero existing memberships may create an org.** ✅ *This restores spec 1's rule — correct under the single-org invariant (§1). A user already locked into a workspace cannot spin up a second one. (An earlier draft removed this restriction to allow multi-workspace founders; that scenario is now explicitly out of scope.)* Enforced in the plugin hook **and** by the `one_org_per_user` DB index (§3.2). A user who wants a different workspace must first leave/delete their current one (§6.6).
- Creator gets `owner` (plugin `creatorRole` default). Slug is generated server-side, unique, retry-on-collision; org creation is idempotent per (userId, name) within a short window to absorb double-submits.
- `organization_settings` row is created atomically with the org.
- After creation the new membership is the user's sole org; `activeOrganizationId` is set to it automatically.

### 6.2 Onboarding limbo & the invite watcher (FR-8)
- `GET /api/onboarding/state` (auth required, no org required): returns `{ pendingInvites: [...], canCreateWorkspace: boolean }` where invites match `lower(session.user.email)`, status `pending`, unexpired.
- The workspace-setup screen polls this (~15–30s; the Figma "checking every 5s" copy should relax to protect the endpoint — see EC-13) or refreshes on demand.
- Accepting an invite requires `emailVerified = true` (`requireEmailVerificationOnInvitation: true` — plugin option). Accepting sets the active org and routes into the app.

### 6.3 Invitations (FR-9)
- Plugin defaults: 48h expiry (`invitationExpiresIn`), `cancelPendingInvitationsOnReInvite: true`, `invitationLimit` tuned per plan, `sendInvitationEmail` via our mailer.
- **Default invited role: `viewer`.** ❌ *Both specs default to `admin` — least-privilege violation; an admin must explicitly choose a higher role (the Add Team Member modal already has the role picker).*
- Invitation acceptance requires the **logged-in session's email to equal the invitation email** (case-insensitive). A forwarded invite link opened by a different account shows "this invitation is for other@x.com" (EC-11).
- **Single-org lock-in (EC-17):** acceptance also requires the accepting user to have **zero existing memberships**. A user already in a workspace who clicks an invite gets a blocking message — "your account already belongs to *{Org}*; leave it before joining another" — with a link to §6.6. The `one_org_per_user` index (§3.2) is the backstop if two accepts race. Inviting an email that already belongs to a member elsewhere is allowed to *send*, and acceptance is where it's enforced — but **the inviter is never told** the address already holds a workspace (**EC-33**): an "already in a workspace" flag would let any admin probe arbitrary emails to learn who uses wiseonline, contradicting the anti-enumeration posture (§4.2/§4.3) and leaking employee moonlighting to employers. To the inviting admin, such an invite is indistinguishable from any other pending invite that never converts; the explanation surfaces **only to the invitee** at acceptance time.
- Invite tokens: single-use, unguessable, compared timing-safe; treat invitation IDs returned by list endpoints as capability-bearing (plugin caveat) — listing invites requires `members:read` permission.
- Only `owner`/`admin` can invite; inviting to a role ≥ your own requires `owner`.
- Rate-limited per org per day; duplicate pending invites to the same email are collapsed.
- **Seat-quota race (EC-28):** the seat-count check at acceptance runs inside the accept transaction (`SELECT count(*) … FOR UPDATE`-style guard) so two invitees accepting simultaneously cannot both slip past the plan's seat limit.

### 6.4 Roles & permissions (FR-10)
- Built-in roles: `owner`, `admin`, `viewer` (matches the designed Team Access page), defined via `createAccessControl` statements: `assets:{read,write,delete}`, `employees:{read,write,offboard}`, `returns:{read,write}`, `members:{read,invite,remove,update-role}`, `settings:{read,write}`, `billing:{read,write}`, `audit:read`, `apikeys:{read,write}`.
- Org-customizable roles use the plugin's `dynamicAccessControl` (powers the "customize permissions per role" UI). Custom roles can never grant `owner`-only permissions (workspace deletion, ownership transfer).
- Role changes take effect immediately (guards re-read membership per request; no cached role in the cookie is trusted).

### 6.5 Domain capture / auto-join (FR-11)
- Org admins add a domain → we issue a DNS TXT challenge → verification job confirms → domain becomes claimable by exactly one org (partial unique index).
- **Claims expire — periodic re-verification (EC-31):** verification is **not one-shot**. A scheduled job re-checks the TXT record every 30 days (`last_checked_at`); a missing record starts a 7-day grace window with admin alerts, after which the claim **lapses**: auto-join and SSO domain-routing are suspended (existing members are untouched) until re-verified. Without this, a domain that is sold or lost keeps funneling the *new* owner's employees into the *old* org's workspace forever. Lapse also (re)opens the domain to a rival claim per EC-9.
- **Blocklist public email domains** (gmail.com, outlook.com, etc.) — cannot be verified (EC-9).
- Auto-join is **opt-in** (`auto_join_enabled`) and grants at most `auto_join_role` (default `viewer`), only for `emailVerified` users. New signups with a matching verified domain see "Join {Org}" instead of workspace creation. Existing members are untouched.
- **Single-org lock-in (EC-17):** auto-join applies only to users with **zero** existing memberships. A user already in another workspace whose email happens to match a verified domain is **not** auto-joined and **not** moved — they keep their current org and simply never appear in the target org. **No admin-visible flag (EC-33):** disclosing that an employee's address holds an account elsewhere is the same enumeration/privacy leak as in §6.3. This is the enterprise contractor-at-two-companies case: the same email cannot live in two wiseonline orgs.
- If the org enforces SSO, domain-matched signups are routed directly to the SSO flow (SSO plugin `domainVerification` + `defaultSSO` support this).

### 6.6 Membership lifecycle — leave, ownership transfer, workspace deletion (FR-19) — needs explicit specification

Neither source spec described how a user *exits* an org, yet the single-org invariant makes this load-bearing: leaving is the only way to become eligible for a different workspace, and EC-3's "sole owner cannot delete" only makes sense if a transfer/deletion path exists.

- **Leave org (self):** any non-sole-owner member may leave. Leaving removes the `member` row → the user becomes org-less → next request returns `NO_ACTIVE_WORKSPACE` → they land back in onboarding limbo (§6.2), now free to create or accept a new org. Their sessions are rotated; any assigned assets remain the org's and are flagged for the offboarding/return flow.
- **Ownership transfer:** an `owner` may promote another member to `owner` and (optionally) step down. Transfer is a single transactional operation (`@RequiresFreshSession()`, audited) that guarantees ≥1 owner at all times (EC-3 locking).
- **Sole owner exit:** a sole owner cannot *leave* or *delete their account* while the org has other members — they must first transfer ownership (EC-3). A sole owner who is also the **only member** has no one to transfer to; their only exit is **workspace deletion**.
- **Workspace deletion (owner-only, `@RequiresFreshSession()`, destructive):** deletes the org and cascades — removes all members (each becomes org-less and returns to limbo), voids pending invitations, revokes all org sessions, cancels billing/seats, and hands **in-flight assets** (status `in_transit` / `pending_return` / `pending_qa`) to a wind-down path rather than hard-deleting operational history. Requires typing the workspace name to confirm; soft-deleted with a grace window before purge; fully audited.
- **Mistaken-workspace escape:** because a just-signed-up user who creates a workspace is immediately locked in as sole owner, workspace deletion (of an empty, just-created org) is also the "I set this up wrong / I meant to accept an invite" escape hatch. The onboarding UI surfaces it for freshly created empty workspaces so a user is never permanently trapped by a fat-finger during setup.

---

## 7. Enterprise SSO (FR-12)

- `@better-auth/sso` plugin: per-org SAML 2.0 and OIDC providers, registered through the IdP Setup modal (already designed: SAML metadata upload / OIDC discovery URL).
- Provisioning: `organizationProvisioning: { disabled: false, defaultRole: "viewer", getRole }` — SSO logins auto-join the provider's org; role can be mapped from IdP attributes/groups later. **Single-org lock-in (EC-17):** if the authenticating user already belongs to a *different* org, provisioning must **not** add a second membership or move them — the `provisionUser`/provisioning hook detects the existing membership, denies the SSO sign-in into this org, and flags it for the org admin (same contractor-at-two-companies case as §6.5).
- `provisionUser` hook syncs name/avatar on every login (`provisionUserOnEveryLogin: true`).
- SAML assertions: signature required, timestamp (`NotBefore`/`NotOnOrAfter`) validation with bounded clock skew (plugin built-in), audience restriction, replay-cached assertion IDs.
- **Enforce SSO** toggle (Roles & SSO settings page):
  - Turning it ON requires: ≥1 verified domain, ≥1 tested SSO connection, and the acting owner having completed an SSO login themselves (prevents lockout, EC-6).
  - Enforcement: members cannot access the org with sessions authenticated by password/social (checked at org activation and by OrgGuard, §4.3/§5). Existing non-SSO sessions for that org are revoked at enable-time.
  - **Break-glass (EC-24):** owners may retain password login (`allow_email_login` stays true for `owner` role only) — recommended default ON, org can disable for full lockdown with a signed acknowledgment. ⚠️ This escape hatch is *also the attacker's bypass* — phish one owner password and SSO enforcement is moot. Therefore break-glass password login for an SSO-enforced org **requires our TOTP MFA** on top of the password, even when the org otherwise trusts IdP-asserted MFA (§9). Break-glass logins are audited and can alert org admins.
  - **TOTP enrollment prerequisite (EC-32):** the TOTP requirement above is only real if the TOTP exists. Enabling enforce-SSO with break-glass ON is **blocked until every owner has TOTP enrolled** (the enable flow prompts them through enrollment), and an owner of an SSO-enforced org **cannot remove their last TOTP factor** while break-glass is ON. Otherwise break-glass silently degrades to password-only (defeating EC-24) or, if strictly enforced without enrollment, becomes a lockout (recreating EC-6).
- `disableImplicitSignUp` stays default (SSO can create users) but only into the provider's org via provisioning — never as free-floating users.

---

## 8. SCIM provisioning (FR-13) — **custom NestJS implementation**

⚠️ Better Auth does **not** ship SCIM (verified against current docs; only SSO-login-time provisioning exists). The `/scim/v2/*` endpoints in spec 2 are ours to build as NestJS controllers.

### 8.1 Endpoints & auth
- `POST /scim/v2/Users`, `GET /scim/v2/Users(/:id)`, `PATCH /scim/v2/Users/:id`, `DELETE /scim/v2/Users/:id`, `GET /scim/v2/ServiceProviderConfig`.
- Auth: per-org bearer token (`scim_tokens`, hashed at rest, shown once at creation, rotatable, revocable). Token → org mapping *is* the tenant scope; SCIM requests never touch other orgs. Rate-limited separately from user traffic.
- **Bearer-only (v1.2):** `/scim/v2/*` accepts bearer tokens **exclusively** — session cookies are ignored on these routes. A SCIM controller that also honored cookie auth would be CSRF-able (state-changing endpoints reachable with ambient credentials). Token comparison is constant-time against the stored hash (lookup by token-prefix, then timing-safe equality).

### 8.2 Matching & idempotency rules
1. **Match by `externalId` first, email second (EC-20).** The IdP's stable `externalId` is the primary key for matching; `lower(email)` is only a fallback when no `externalId` match exists, all within the token's org context. This prevents the **recycled-email** trap: when a company offboards `alice@acme.com` and reissues the same address to a new hire, an email-only match would wrongly reattach the *old* user (and their history/personal linkage). A new `externalId` with a reused email must be treated as a **new** identity, never a reattachment.
2. Existing user (matched), `emailVerified = true`, **and not already a member of a different org** → link: create `account` row (`providerId = sso:<provider>`), create/confirm `member` row. Never create a duplicate user (constraint-collision-free by upsert on the unique keys).
3. Existing user, `emailVerified = false` → **reject with 409**, flag to org admins (unverified-takeover guard, EC-2).
4. **Existing user already a member of another org (EC-17)** → **reject with 409** + admin flag; SCIM may not add a second membership or move the user (single-org invariant; `one_org_per_user` index is the backstop).
5. **Email-change collision (EC-21):** a `PATCH` that changes a user's email to an address **already owned by a different wiseonline user** → **reject with 409** + admin flag. Never blind-`UPDATE` (violates the email unique index) and never silently merge the two identities. Match the target by `externalId`; only apply the new email if it is free.
6. No user → create user (verified, since the IdP owns the mailbox), account, member.
7. All operations idempotent: replaying the same SCIM payload is a no-op. `externalId` is stored on the user record for stable matching across email changes.

### 8.3 Deprovisioning (`DELETE` or `active: false` PATCH)
1. Set member state `deprovisioned` and revoke **all** of that user's sessions. Under the single-org invariant this is the user's only org, so deprovisioning ends their access entirely and returns them to org-less/limbo if they ever sign in again. *(The org-scoped revocation logic is retained as defense-in-depth — EC-12 — so that if a stray second membership ever exists it is not collaterally destroyed; but in normal operation there is no other org to spare.)*
2. Remove the member row (**hard delete** — v1.2 decision, §3.2: matches the plugin's behavior and frees the `one_org_per_user` slot for a future re-hire; deprovision history lives in `audit_logs` and the SCIM log, not tombstone rows); keep the `user` row.
3. If an `employees` row matches the email → trigger the offboarding flow (asset unassignment + return logistics — feeds the designed Return Logs pipeline).
4. Emit `user.deprovisioned` webhook + audit event.

---

## 9. MFA (FR-14)

- Better Auth `twoFactor` plugin: TOTP + one-time backup codes (hashed). QR enrollment in Account Settings → Security (designed).
- `mfa_required` org setting: OrgGuard blocks org resources for members without MFA enrolled — response `403 { code: "MFA_ENROLLMENT_REQUIRED" }`; the web traps this into a forced enrollment flow. Grace period configurable (default 7 days from joining), after which access is blocked.
- MFA is verified at sign-in (plugin flow) and counts toward session freshness for step-up (§4.4). It is also the required second factor for enforce-SSO break-glass password login (§7, EC-24).
- **Verification brute force (EC-25):** a 6-digit TOTP is only ~1M possibilities, so the verify endpoint gets its own **tight, dedicated rate limit** (independent of the login limiter), rejects a **replayed code within the same time step**, and throttles **backup-code** attempts even harder (they are higher-value and fewer). Lockout on repeated MFA failure escalates to step-up/support, not a bare account block (avoid the EC-18 lockout weapon).
- SSO-authenticated members satisfy `mfa_required` if the IdP asserts MFA (AMR/ACR claim) — otherwise our TOTP applies on top. Default: trust IdP.
- Losing all factors: recovery via backup codes; else support-driven identity verification + owner approval, fully audited.

---

## 10. API keys, audit, webhooks, compliance

### 10.1 API keys (FR-15)
- `apiKey` plugin. Keys are org-scoped (org id + scopes in key metadata), prefixed (`wo_live_…`), hashed at rest, shown once. Expiry optional; per-key rate limits. Keys authenticate as a service principal — requests pass OrgGuard with `actor_type = api_key` and the key's scopes replace role permissions. Creation/revocation requires fresh session + `apikeys:write`, and is audited.
- **No escalation, no orphans (EC-29):** a key's scopes must be a **subset of the creator's own permissions at creation time** — an `admin` cannot mint a key carrying owner-level scopes and use it to do what their role forbids. Every key records its creator. When a member is **removed or deprovisioned**, keys they created are **automatically revoked**; when a member is **demoted**, their keys whose scopes now exceed the new role are suspended pending owner review. Without this, a departed admin retains API access through a memorized key indefinitely.

### 10.2 Audit logging (FR-16)
- 100% coverage on write actions + auth events: login success/failure, logout, password/email change, MFA enroll/disable, session revocation, member invite/join/role-change/removal, SSO & SCIM config changes, enforce-SSO toggles, API key lifecycle, impersonation start/stop, asset/employee mutations, data export, deletion requests.
- Append-only (INSERT/SELECT grants only), written in the same transaction as the mutation where feasible.
- Retention configurable per org (90–365 days), soft-delete before purge. GDPR erasure pseudonymizes `actor_user_id` rather than deleting rows (integrity vs. erasure balance).
- Surfaced in-app (permission `audit:read`) with filter/export.

### 10.3 Webhooks (FR-17)
- Events: `user.created`, `user.deprovisioned`, `member.joined`, `member.removed`, `asset.assigned`, `asset.returned`, `employee.offboarded`.
- Per-endpoint HMAC-SHA256 signatures with timestamp header (replay window 5 min), retries with exponential backoff, automatic disable after sustained failure, delivery log.
- **SSRF egress control (EC-26):** customer-supplied webhook URLs are an SSRF vector. On save and again at delivery time, resolve the host and **reject private / link-local / loopback / metadata targets** (RFC 1918, `127.0.0.0/8`, `::1`, `169.254.0.0/16` incl. `169.254.169.254`, `fd00::/8`). HTTPS only, **do not follow redirects**, pin/re-validate the resolved IP at connect time to defeat DNS-rebinding (TOCTOU), and deliver from an egress-restricted network path. No internal service or cloud metadata endpoint is ever reachable through a webhook.
- **Org-scoped delivery (v1.2):** webhook endpoints are configured per org and receive **only that org's events** — no cross-org event ever reaches an endpoint. `user.created` fires in the org context at member-join time (under the single-org invariant there is no org-less user event to deliver).

### 10.4 Compliance (FR-18)
- GDPR: self-serve data export (fresh session required); account deletion workflow with 14-day grace, blocked while the user is a sole owner (EC-3, §6.6).
- **Export scope (v1.2):** the export contains the **requesting user's own personal data only** — never org operational data (assets, employees) and never other members' PII that co-occurs in shared records. Audit entries in the export are filtered to the requester's own actions, with other actors pseudonymized.
- TLS 1.2+ everywhere; managed at-rest encryption; field-level encryption for TOTP secrets and SCIM tokens (already required above); PII minimization in logs.
- Seat counting from `member` rows for billing; over-quota blocks **invitations** (not existing members' access); the seat check at invite-accept is transactional (EC-28).
- **Webhook PII limitation (accepted, non-code):** GDPR erasure cannot recall PII already delivered to a customer's webhook endpoint — that data now lives in the customer's system. This is handled contractually (data-processor terms), and mitigated by minimizing PII in webhook payloads (prefer IDs over personal fields; let the customer fetch details via authenticated API). Documented so it is a known, accepted limitation rather than a silent gap.

### 10.5 Support access (new — neither spec covers it)
- Better Auth `admin` plugin for internal support: user lookup, session revocation, impersonation. Impersonated sessions are visibly bannered, time-boxed (30 min), require support-staff MFA, and audit `actor_type = impersonation`. Customer-facing toggle: "allow wiseonline support access" (default on for free, contractual for enterprise).
- **Impersonation is read-mostly (EC-23):** an impersonated session is **hard-blocked** from every `@RequiresFreshSession()` / destructive endpoint by the OrgGuard (§5 L1 step 6) — role changes, billing, SSO/SCIM config, API-key creation, workspace deletion, data export. Impersonation can pass a freshness check by timestamp, so freshness alone is *not* the gate; the impersonation flag is. This stops a phished/rogue support account (or a coerced agent) from performing the exact sensitive actions step-up exists to protect. Any action requiring true user authority must be done by the user, not on their behalf.

---

## 11. Edge Case Matrix

Merged from both specs (EC-1…4), corrected, and extended with new cases found in review (EC-5…16), the single-org-invariant pass (EC-17…28), and the pre-implementation security review (EC-29…33).

| # | Edge case | Resolution |
|---|---|---|
| **EC-1** | **Invite/signup collision** — invitee signs up independently before accepting | Limbo state + invite watcher (§6.2). Match on normalized email, require verified email to accept. |
| **EC-2** | **SSO migration & verified-hijack** — attacker pre-registers `ceo@company.com` unverified before enterprise SSO lands | SCIM/SSO link only when `emailVerified = true`; unverified match → 409 + admin flag (§8.2). Account linking requires verified email both sides (§4.5). Enforce-SSO revokes existing non-SSO org sessions. |
| **EC-3** | **Orphaned tenant** — last owner demoted/removed/deleted | Owner-count assertion inside the same transaction as the mutation (`SELECT … FOR UPDATE` on member rows — the check in spec 1 is racy: two concurrent demotions can each see count=2). Account deletion blocked for sole owners until ownership transfer or workspace deletion. |
| **EC-4** | **Stale session on shared machine** doing destructive actions | `session.freshAge` 15 min + `@RequiresFreshSession()` step-up (§4.4). |
| **EC-5** | **Spoofed active org** — client sets `activeOrganizationId` to a foreign org | Membership re-verified per request server-side (§5 L1); RLS backstop (L3). |
| **EC-6** | **SSO lockout** — org enables enforce-SSO with a broken IdP config | Enable requires a completed test login by the acting owner; owner break-glass password path; support-side disable flow (audited) (§7). |
| **EC-7** | **Cookie-cache revocation lag** — revoked session stays valid via cached cookie | Cache maxAge ≤ 5 min; role/membership never trusted from cache; `cookieCache.version` bump for global kill (§2.3). |
| **EC-8** | **RLS leakage via connection pooling** — `SET` bleeds across pooled tenants | `SET LOCAL` in per-request transactions only; PgBouncer transaction mode; `FORCE ROW LEVEL SECURITY`; `NOBYPASSRLS` app role (§5 L3). |
| **EC-9** | **Domain squatting** — org verifies `gmail.com`, or races another org for `acme.com` | Public-domain blocklist; DNS TXT proof; uniqueness only among *verified* rows; disputes resolved by re-verification (TXT removal loses the claim) (§6.5). |
| **EC-10** | **Auto-join overreach** — contractor with a company mailbox auto-joins and sees all assets | Auto-join opt-in, max role `viewer`, verified email only; admins can convert to invite-approval mode (§6.5). |
| **EC-11** | **Forwarded invite link** — wrong logged-in account accepts an invite meant for someone else | Acceptance requires session email == invitation email (§6.3). |
| **EC-12** | **Deprovision session scoping** — an org's IdP deletes a user | Deprovision removes the membership + revokes sessions; the `user` row survives (so a future re-invite works). Under single-org this ends all access; the org-scoped (rather than global) revocation logic is retained as defense so a stray second membership couldn't be collaterally wiped (§8.3). |
| **EC-13** | **Onboarding poller as a DoS/enumeration vector** — 5s polling of invite-check across many idle accounts | Endpoint returns only invites addressed to the authenticated email; per-user rate limit; poll interval ≥15s with jitter (§6.2). |
| **EC-14** | **Mixed SSO enforcement** — historically "user in an SSO-enforced org and a password org" | N/A under the single-org invariant (a user has one org, so one enforcement posture). Enforcement is still evaluated per request against that org (§4.3). Retained for traceability; superseded by §1. |
| **EC-15** | **Session fixation / stale privilege on security events** — password change, MFA enrollment, email change leave old sessions alive | Revoke other sessions on all three events (§4.4); role changes propagate immediately because guards re-read membership (§6.4). |
| **EC-16** | **OAuth provider returns unverified or attacker-controlled email** | Trust `email_verified` only from Google/Microsoft; everything else re-verifies; account linking restricted to trusted providers (§4.2, §4.5). |
| **EC-17** | **Single-org lock-in collision** — an invite / domain auto-join / SCIM-SSO provisioning targets a user who *already* belongs to another org | All secondary joins **rejected**, never silent add/move. Enforced at invite-accept (§6.3), auto-join (§6.5), SSO provisioning (§7), and SCIM (§8.2 rule 4); DB `one_org_per_user` unique index is the backstop (§3.2). Rejection is disclosed to the **invitee only** for invites/auto-join (EC-33); SCIM keeps its 409 + admin flag (the IdP admin already owns that directory). Contractor-at-two-companies case. |
| **EC-18** | **Stale-tab / spoofed org write misroutes into the wrong workspace** | Per-request org binding: an explicit org in path/header must equal the session org → else `403 ORG_CONTEXT_MISMATCH`; writes re-derive `organizationId` from auth context, never the body (§5 L1 step 4). Single-org makes misrouting a non-scenario, but the binding + RLS enforce it against bugs. |
| **EC-19** | **Targeted-account lockout DoS** — attacker floods failed logins for a victim's email to lock them out | Throttle primarily by IP (combined IP+account key), account throttle only after IP abuse, exempt valid trusted-device cookies, escalate to step-up/CAPTCHA instead of hard-locking a legitimate user (§4.3.1). Same principle for MFA-verify failures (EC-25). |
| **EC-20** | **Recycled corporate email** — offboarded `alice@acme.com` reissued to a new hire; SCIM/SSO email-match would reattach the old user | Match by IdP `externalId` first, email only as fallback; a new `externalId` + reused email is a **new** identity, never a reattachment (§8.2 rule 1). |
| **EC-21** | **SCIM/SSO email-change collision** — IdP PATCHes a user's email to one already owned by a different wiseonline user | Reject with 409 + admin flag; never blind-`UPDATE` (unique-index violation) and never merge identities (§8.2 rule 5). |
| **EC-22** | **RLS fail-open regression** — a query runs with `app.current_org` unset, or someone "fixes" the policy to match-all | Fail closed: unset GUC → `NULL` → zero rows; ban COALESCE/default-to-`''` in the policy; required test asserts no-setting ⇒ zero rows (§5 L3). |
| **EC-23** | **Impersonation privilege escalation** — a support impersonation session (or phished support account) performs sensitive actions | Impersonated sessions hard-blocked from all `@RequiresFreshSession()`/destructive endpoints by the guard — the impersonation flag is the gate, not freshness (§5 L1 step 6, §10.5). |
| **EC-24** | **Break-glass phishing** — the enforce-SSO owner password escape is also the attacker's SSO bypass | Break-glass password login for an SSO-enforced org requires our TOTP MFA on top of the password, audited + admin-alertable, even when IdP MFA is otherwise trusted (§7, §9). |
| **EC-25** | **MFA/TOTP brute force** — 6-digit code is ~1M guesses | Dedicated tight rate limit on verify (separate from login), reject replayed code within the same time step, throttle backup-code attempts harder; failures escalate to step-up, not a bare lock (§9). |
| **EC-26** | **Webhook SSRF** — customer webhook URL points at internal/metadata targets (`169.254.169.254`) | Block private/link-local/loopback/metadata ranges at save + delivery, HTTPS only, no redirect following, re-validate resolved IP at connect (anti DNS-rebinding), egress-restricted network (§10.3). |
| **EC-27** | **Sole-owner exit / permanent lock-in** — under single-org a mistaken or departing sole owner has no membership to fall back to | Ownership transfer + workspace deletion are the exits; leaving your only org returns you to onboarding limbo (org-less) to create/accept anew; empty just-created workspaces expose a delete-to-escape path so setup fat-fingers don't trap the user (§6.6, EC-3). |
| **EC-28** | **Seat-quota race** — two invitees accept simultaneously and both slip past the plan seat limit | Seat check runs inside the accept transaction with row locking so concurrent accepts can't both pass (§6.3, §10.4). |
| **EC-29** | **API-key escalation & orphaned keys** — an `admin` mints a key with owner-level scopes; a removed member retains a memorized key | Key scopes ⊆ creator's permissions at creation; keys record their creator; auto-revoke on removal/deprovision, suspend-for-review on demotion (§10.1). |
| **EC-30** | **SSO step-up rubber stamp** — a live IdP cookie silently satisfies the fresh-session re-auth on the shared machine EC-4 targets | Step-up for SSO sessions sends `ForceAuthn`/`prompt=login`+`max_age=0` and rejects assertions predating the challenge; TOTP fallback if the IdP ignores forced re-auth (§4.4). |
| **EC-31** | **Stale domain claim** — verification was one-shot; a sold/lost domain keeps routing the new owner's signups into the old org | Periodic DNS TXT re-verification (30-day cycle, 7-day grace + alerts); lapse suspends auto-join and SSO domain-routing until re-verified and reopens the claim (§6.5). |
| **EC-32** | **Break-glass TOTP gap** — an owner without TOTP enrolled makes break-glass password-only (defeats EC-24) or a lockout (recreates EC-6) | Enabling enforce-SSO with break-glass ON requires all owners TOTP-enrolled; owners of enforced orgs cannot remove their last TOTP factor while break-glass is ON (§7, §9). |
| **EC-33** | **Membership-flag enumeration oracle** — "already in a workspace" flags let any admin probe emails for wiseonline accounts (and expose moonlighting) | No inviter/admin-visible flags for invites or auto-join; the invite just stays pending; the explanation surfaces only to the invitee at acceptance. SCIM's 409 + flag is retained — a different trust context (§6.3, §6.5, §8.2). |

---

## 12. Gaps this PRD adds beyond the two source specs

For traceability — items that neither spec addressed:

1. **Cross-origin cookie architecture** between `apps/web` and `apps/api` (§2.2) — the single biggest unstated implementation risk.
2. Middleware returning **200 for the limbo state** (spec 1) replaced with `403 + code` and dedicated onboarding endpoints (§5, §6.2).
3. **Least-privilege invite default** (`viewer`, not `admin`).
4. `allowUserToCreateOrganization` **kept** at zero-membership (spec 1 was right for our single-org model) and backed by a `one_org_per_user` DB unique index — enforces one org per user (§1, §3.2, EC-17). *(This reverses an intermediate v1 draft that had removed the restriction.)*
5. **Account enumeration resistance** across signup, sign-in, and password reset (§4.2, §4.3, §4.6).
6. **Email normalization** rules (§3.2).
7. **Owner-count race condition** in the last-owner check — transactional locking (EC-3).
8. **Domain verification via DNS TXT + public-domain blocklist** — spec 2 had a bare `verified` boolean and a global unique that invites squatting (§6.5, EC-9).
9. **SCIM is custom** — Better Auth has no SCIM; scoped, tokened, idempotent design specified (§8).
10. **Break-glass and test-login preconditions** for enforce-SSO (EC-6).
11. **Support impersonation** with consent, banner, time-box, audit (§10.5).
12. **Webhook signing + replay protection** (§10.3).
13. **Audit-log immutability grants and GDPR pseudonymization** (§10.2).
14. **Breached-password checking** and NIST-aligned password policy (§4.2).
15. **employees vs users distinction** made explicit (§3.3).
16. Config-shape corrections: organization roles via access control / `dynamicAccessControl`; MFA/API-key plugin tables instead of hand-rolled ones (§3.1).

Added in the v1.1 single-org-invariant pass:

17. **Single-organization-per-user invariant** as an explicit product rule with an application-layer + DB-index enforcement, and the collision behavior at every join surface (§1, §3.2, EC-17).
18. **Membership lifecycle** — leave-org, ownership transfer, and workspace deletion — was referenced (EC-3) but never specified; now a full section incl. the mistaken-workspace escape hatch (§6.6, EC-27).
19. **Per-request org binding** against stale-tab misrouting, not just session-trust (§5, EC-18).
20. **Targeted-account lockout DoS** — turning per-account rate limiting from a defense into a non-weapon (§4.3, EC-19).
21. **Recycled-email + email-change collision** handling in SCIM via `externalId`-first matching (§8.2, EC-20/EC-21).
22. **RLS fail-closed** as a stated, tested invariant (§5, EC-22).
23. **Impersonation confined to read-mostly** — hard-blocked from sensitive endpoints by flag, not freshness (§10.5, EC-23).
24. **Break-glass hardened with mandatory TOTP** so the SSO escape hatch isn't a phishing bypass (§7, EC-24).
25. **MFA/TOTP verify brute-force** limits (§9, EC-25).
26. **Webhook SSRF** egress controls (§10.3, EC-26).
27. **Seat-quota race** made transactional (§6.3/§10.4, EC-28).
28. **GDPR/webhook PII limitation** stated as an accepted, mitigated non-code gap (§10.4).

Added in the v1.2 pre-implementation security review:

29. **API-key scope subsetting + orphan revocation** — keys can't exceed their creator's permissions and don't survive their creator's departure (§10.1, EC-29).
30. **Forced IdP re-authentication for SSO step-up** — silent SSO completion no longer satisfies the fresh-session challenge (§4.4, EC-30).
31. **Domain claim expiry** — periodic DNS TXT re-verification with lapse suspending auto-join/SSO routing (§6.5, EC-31).
32. **Break-glass TOTP enrollment prerequisite** — enforce-SSO enable blocked until owners hold TOTP; last factor unremovable while break-glass is ON (§7, EC-32).
33. **Enumeration-oracle removal** — the v1.1 "already in a workspace" admin flags reversed; disclosure is invitee-side only (§6.3, §6.5, EC-33).
34. Spec corrections: `verified_domains` duplicate UNIQUE constraint removed (§3.2); `audit_logs.organization_id` made nullable for pre-org auth events (§3.2); member-row lifecycle unified on **hard delete** + plain unique index (§3.2, §8.3); `session_timeout_minutes` defined as a bounded absolute cap (§4.4); SCIM bearer-only + constant-time compare (§8.1); webhook org-scoping stated (§10.3); GDPR export scope stated (§10.4); production cookie architecture prefers same-host path routing with `__Host-` (§2.2); trusted-device cookie softens rather than exempts rate limits (§4.3); deployment gate — no public deployment before the Phase-1 security baseline (kanban).

Deliberately deferred (recorded as backlog): passkeys, `multiSession` account switching, IdP group→role mapping, SCIM Groups endpoint, anomaly detection on sessions (impossible travel), org data residency, idle-based org session timeout.

---

## 13. Rollout phases

| Phase | Scope | Exit criteria |
|---|---|---|
| **P1 — Core (MVP)** | Email/password + Google/Microsoft OAuth, email verification, password reset, org create/invite/limbo flow, roles (owner/admin/viewer), guards + repository scoping + RLS, sessions UI, rate limiting, audit skeleton | Isolation test suite green (see §14); onboarding E2E matches Figma flows |
| **P2 — Team hardening** | MFA (TOTP), org settings (session timeout, MFA required), fresh-session step-up, API keys, webhooks, full audit coverage, GDPR export/delete | Pen-test findings ≤ low; SOC 2 control mapping drafted |
| **P3 — Enterprise** | SAML/OIDC SSO + IdP setup UI, domain verification + auto-join, enforce-SSO, SCIM, dynamic custom roles, impersonation tooling | Two design-partner IdPs (Okta + Entra) pass full lifecycle: provision → role change → deprovision → asset return |

---

## 14. Acceptance & test matrix (minimum)

1. **Isolation:** for every tenant table, an authenticated member of org A issuing reads/writes with org B identifiers gets 403/404 and RLS blocks at the DB layer even with the guard artificially disabled in the test harness.
2. **Limbo:** fresh signup with no invites → workspace setup; pending invite appears via watcher without re-login; acceptance with mismatched session email fails.
3. **Last owner:** concurrent demotion of two owners leaves ≥1 owner (transactional test).
4. **Enforce SSO:** password-holder in an enforced org cannot access it via password; enable-time revocation of non-SSO sessions verified; owner break-glass works **only with password + TOTP** (EC-24).
5. **SCIM:** replayed create is idempotent; unverified-email match rejected; `externalId`-first matching rejects a recycled-email reattachment (EC-20); email-change to an occupied address 409s (EC-21); deprovision revokes sessions and opens a return-logs entry when an employee record matches.
6. **Freshness:** 16-minute-old session hitting a role-change endpoint gets `SECURITY_CHALLENGE_REQUIRED`; succeeds after re-auth.
7. **Revocation:** "revoke all sessions" invalidates other devices within cookie-cache maxAge; password change revokes other sessions immediately.
8. **Enumeration:** signup/reset/sign-in responses and timings are uniform for existing vs non-existing emails.
9. **Rate limits:** login, invite, SCIM, MFA-verify, and onboarding-poll limits enforced and observable.
10. **Single-org invariant (EC-17):** a user already in org A cannot accept an org-B invite, be domain-auto-joined, or be SSO/SCIM-provisioned into org B — each is rejected/flagged; a direct attempt to insert a second `member` row hits `one_org_per_user` and fails.
11. **Lifecycle (EC-27):** leaving your only org returns you to limbo and lets you create/accept anew; a sole owner with other members cannot leave/delete until transfer; a sole-owner/sole-member can delete-to-escape; deletion cascades members→limbo, revokes sessions, cancels seats.
12. **Org-context binding (EC-18):** a request whose explicit org id ≠ session org gets `403 ORG_CONTEXT_MISMATCH`; a write cannot be steered by a body-supplied `organization_id`.
13. **RLS fail-closed (EC-22):** a query executed with no `app.current_org` set returns zero rows (not all rows).
14. **Impersonation (EC-23):** an impersonation session is refused on every `@RequiresFreshSession()`/destructive endpoint even when the session timestamp is fresh.
15. **Targeted lockout (EC-19):** attacker-sourced failed logins for a victim do not hard-lock the victim's ability to log in from a trusted device.
16. **Webhook SSRF (EC-26):** saving/delivering to `169.254.169.254`, `127.0.0.1`, or an RFC-1918 host is rejected; redirects are not followed.
17. **API keys (EC-29):** an `admin` cannot create a key whose scopes exceed their role; after the creator is removed from the org, their keys stop authenticating.
18. **SSO step-up (EC-30):** a step-up round that completes via silent IdP SSO (no forced re-auth) is rejected; one with `ForceAuthn` honored succeeds.
19. **Domain lapse (EC-31):** removing the TXT record → after the re-verification job + grace, auto-join and SSO domain-routing are suspended; restoring the TXT re-enables them.
20. **Break-glass prerequisite (EC-32):** enabling enforce-SSO with break-glass ON fails while any owner lacks TOTP; an enrolled owner cannot remove their last TOTP factor while it is ON.
21. **Invite enumeration (EC-33):** inviting an address that belongs to a member of another org is indistinguishable — in response, timing, and list display — from inviting a fresh address.

## 15. Open questions

1. Break-glass default for enforce-SSO: owner password escape ON by default, or fully locked with support-mediated recovery? (Recommend ON.)
2. Should domain auto-join be available on the free tier or gated to paid plans (abuse surface vs growth loop)?
3. Trust IdP MFA claims (AMR) to satisfy `mfa_required`, or always require our TOTP for enterprise orgs? (Recommend trust IdP, org-overridable.)
4. Audit retention default: 90 or 365 days? Storage cost vs enterprise expectations.
5. Do employees ever become users in v1 (self-serve return portal for departing employees)? Currently out of scope but affects the email-matching design.
