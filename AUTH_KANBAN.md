# Auth Kanban — wiseonline

Source: `AUTHENTICATION_PRD.md`. One card = one branch = one PR. Cards are ordered so you can pull from the top of each phase; **Depends** must be merged first.

**How to use with GitHub Projects:** create a Project (Board layout) with columns `Backlog · Ready · In Progress · In Review · Done`. Paste each card below as a draft issue (title = card heading, body = everything under it), or convert this file to real issues with `gh issue create` once the repo is on GitHub. Suggested labels: `phase:1|2|3`, `area:api`, `area:web`, `area:db`, `security`, `test`.

Branch convention: `feat/*`, `chore/*`, `test/*` off `main`; PR title = card title.

> **Core invariant (PRD §1):** a user belongs to **exactly one organization** at a time — no multi-org membership, no workspace switcher. Enforced in-app *and* by a `one_org_per_user` DB index; the multi-tenant isolation machinery is kept as defense-in-depth. This threads through cards 1.8, 1.9, 1.12, 3.3, 3.5 and the lifecycle card 2.10. v1.1 of the PRD added edge cases **EC-17…EC-28**; the affected cards below carry an "Added in PRD v1.1" criteria block. The v1.2 pre-implementation security review added **EC-29…EC-33** + spec corrections (v1.2 blocks below).

> ⚠️ **Deployment gate (PRD v1.2):** **no publicly reachable deployment** of the API until the Phase-1 security baseline is merged — 1.9 (guards), 1.10 (RLS), 1.14 (rate limiting), 1.16 (audit), 1.17 (isolation suite). Cards 1.2–1.8 put live credential endpoints in the codebase; between their merge and the baseline, deploy only behind private access (VPN/localhost/preview auth). Sign-up/sign-in with no brute-force protection or audit trail must never face the internet.

---

## Phase 1 — Core (MVP)

### 1.1 Postgres + Drizzle foundation
`chore/db-drizzle-setup` · labels: `phase:1 area:db area:api` · depends: —
Set up local Postgres (docker-compose), Drizzle ORM in `apps/api`, config, migration scripts, and a health check.
- [ ] `docker compose up` starts Postgres; `.env.example` documents `DATABASE_URL`
- [ ] Drizzle configured with migrations folder + `pnpm --filter api db:migrate` / `db:generate` scripts
- [ ] Separate DB roles: `app_user` (NOBYPASSRLS) for runtime, `migrator` for migrations (PRD §5 L3)
- [ ] API `/health` reports DB connectivity

### 1.2 Better Auth core mounted in NestJS
`feat/auth-core` · labels: `phase:1 area:api security` · depends: 1.1
Install Better Auth, mount handler at `/api/auth/*` on the Nest HTTP adapter (body-parser disabled for that subtree), email/password enabled with `requireEmailVerification`, scrypt defaults. Generate schema via `@better-auth/cli generate`.
- [ ] `GET /api/auth/ok` returns `{ status: "ok" }`
- [ ] `BETTER_AUTH_SECRET`/`BETTER_AUTH_URL` from env; documented in `.env.example`
- [ ] Sign-up/sign-in/sign-out work via HTTP (unverified users cannot sign in)
- [ ] `trustedOrigins` = web origins only; CSRF/origin checks NOT disabled (PRD §2.2)

### 1.3 Next.js auth client + dev proxy
`feat/web-auth-client` · labels: `phase:1 area:web` · depends: 1.2
`createAuthClient` (better-auth/react) in `apps/web`, Next `rewrites` proxying `/api/*` → `localhost:4000` so cookies stay same-origin in dev (PRD §2.2).
- [ ] `useSession()` reflects login state across reloads
- [ ] Auth requests flow through the rewrite (no CORS, no third-party cookies)
- [ ] Session cookie is `HttpOnly`, `SameSite=Lax`; `Secure` in prod config
- [ ] **(v1.2)** prod architecture documented as same-host path routing (`app.wiseonline.com/api/*` reverse-proxied) enabling the `__Host-` cookie prefix; `Domain=.wiseonline.com` cross-subdomain cookies only as a consciously chosen fallback (subdomain-takeover exposure — PRD §2.2)

### 1.4 Transactional email + verification flow
`feat/auth-email-verification` · labels: `phase:1 area:api` · depends: 1.2
Mailer abstraction (provider TBD — Resend/SES), `sendVerificationEmail` + `sendOnSignUp`, uniform anti-enumeration responses (PRD §4.2).
- [ ] Verification email sent on signup; link verifies and signs in
- [ ] Signup with an existing email returns the same response + sends "you already have an account" email
- [ ] Dev mode logs emails to console instead of sending

### 1.5 Password reset
`feat/auth-password-reset` · labels: `phase:1 area:api security` · depends: 1.4
`sendResetPassword` flow: 1h single-use token, uniform response whether the email exists (PRD §4.6).
- [ ] Reset link expires after 1h and cannot be reused
- [ ] Response identical for existing vs unknown email
- [ ] Successful reset revokes all other sessions (EC-15)

### 1.6 Google + Microsoft OAuth
`feat/auth-social-oauth` · labels: `phase:1 area:api` · depends: 1.2
`socialProviders.google` + `.microsoft` (multi-tenant Entra app). Trust `email_verified` from these two providers only (EC-16).
- [ ] OAuth signup + login round-trip works in dev
- [ ] `callbackURL` validated against `trustedOrigins` (open-redirect guard)
- [ ] Account linking OFF for now (arrives in card 2.10)

### 1.7 Auth UI pages
`feat/web-auth-pages` · labels: `phase:1 area:web` · depends: 1.3, 1.4, 1.5, 1.6
Build Login, Register, Forgot, Reset from the Figma designs (Auth section), incl. Google/Microsoft buttons and error states.
- [ ] Matches Figma auth frames (Poppins, ShadCN-style components)
- [ ] Verification-pending, invalid-token, and uniform-error states implemented
- [ ] Redirect-after-login honors a safe `next` param (same-origin only)

### 1.8 Organization plugin + workspace creation
`feat/auth-organizations` · labels: `phase:1 area:api` · depends: 1.2
Organization plugin: creator becomes `owner`, server-generated unique slug with collision retry, `organization_settings` row created atomically, per-user org-creation cap (PRD §6.1).
- [ ] Creating an org sets `activeOrganizationId` on the session
- [ ] Double-submit within a short window doesn't create duplicate orgs
- [ ] `organization_settings` defaults per PRD §3.2
- [ ] **(v1.1, EC-17)** `allowUserToCreateOrganization` restricted to zero-membership users; `one_org_per_user` unique index on `member(user_id)` added as DB backstop
- [ ] **(v1.2)** membership exits are **hard deletes** (plugin behavior; plain unique index, no `deleted_at`); exit history lives in `audit_logs`, not tombstone rows (PRD §3.2)

### 1.9 AuthGuard + OrgGuard (tenant context)
`feat/api-guards` · labels: `phase:1 area:api security` · depends: 1.8
Nest guards per PRD §5 L1: session validation → membership re-verification on **every** request → request context `{ userId, organizationId, role }`. Missing org → `403 { code: "NO_ACTIVE_WORKSPACE" }` (never 200).
- [ ] Spoofed `activeOrganizationId` for a non-membership org → 403 (EC-5)
- [ ] Role read fresh from DB per request (no cookie-cached role trusted)
- [ ] Guards unit-tested incl. expired session, no org, revoked membership
- [ ] **(v1.1, EC-18)** explicit request org id (path/header) ≠ session org → `403 ORG_CONTEXT_MISMATCH`; writes re-derive `organizationId` from auth context, never the body; guard exposes an impersonation flag for downstream blocking (EC-23)

### 1.10 Tenant-scoped repositories + Postgres RLS
`feat/db-rls-isolation` · labels: `phase:1 area:db security` · depends: 1.9
Layer 2+3 of PRD §5: repository that injects `organization_id`, and RLS (`ENABLE` + `FORCE`) on all tenant tables with per-request `SET LOCAL app.current_org` transactions.
- [ ] `SET LOCAL` inside a transaction wrapper — nothing session-scoped (EC-8)
- [ ] `FORCE ROW LEVEL SECURITY`; runtime role has `NOBYPASSRLS`
- [ ] With the guard bypassed in a test harness, RLS still blocks cross-tenant reads/writes
- [ ] **(v1.1, EC-22)** fail closed: policy denies when `app.current_org` unset (no COALESCE/default-to-empty); test asserts no-setting ⇒ zero rows

### 1.11 Onboarding limbo + invite watcher
`feat/onboarding-limbo` · labels: `phase:1 area:api area:web` · depends: 1.9, 1.7
`GET /api/onboarding/state` (auth, no org) returning pending invites by normalized email; Workspace Setup page from Figma with the invite watcher (poll ≥15s + jitter, EC-13).
- [ ] Web routes `NO_ACTIVE_WORKSPACE` → Workspace Setup screen
- [ ] Pending invite appears in the watcher without re-login
- [ ] Endpoint rate-limited per user; returns only invites for the session email

### 1.12 Invitations
`feat/auth-invitations` · labels: `phase:1 area:api area:web security` · depends: 1.11
Org invitations per PRD §6.3: 48h expiry, default role `viewer`, `cancelPendingInvitationsOnReInvite`, `requireEmailVerificationOnInvitation`, invite email, Add Team Member modal wiring.
- [ ] Acceptance requires session email == invitation email, case-insensitive (EC-11)
- [ ] Unverified users cannot accept; invite tokens single-use
- [ ] Inviting to a role ≥ your own requires `owner`; invites rate-limited per org/day
- [ ] **(v1.1, EC-17)** acceptance requires zero existing memberships; already-member user blocked with "leave {Org} first" — shown to the **invitee only**
- [ ] **(v1.2, EC-33)** the inviter is **never** told an address already holds a workspace — no "already in a workspace" flag in the invite list; such invites are indistinguishable (response, timing, display) from any pending invite (enumeration oracle)
- [ ] **(v1.1, EC-28)** seat-count check runs inside the accept transaction with row locking (concurrent accepts can't both exceed the seat limit)

### 1.13 RBAC — owner/admin/viewer
`feat/auth-rbac` · labels: `phase:1 area:api security` · depends: 1.9
`createAccessControl` statements + three built-in roles per PRD §6.4; permission decorator for controllers; last-owner safeguard with row locking (EC-3).
- [ ] Permission matrix from PRD §6.4 enforced on all existing endpoints
- [ ] Concurrent demotion test leaves ≥1 owner (transactional `FOR UPDATE`)
- [ ] Role change takes effect on the next request without re-login
- [ ] **(v1.1)** last-owner safeguard (EC-3) lives here; full ownership-transfer / leave / deletion flows are card **2.10** (§6.6)

### 1.14 Rate limiting + Redis session storage
`feat/auth-rate-limiting` · labels: `phase:1 area:api security` · depends: 1.2
Redis as `secondaryStorage` (`storeSessionInDatabase: true`), Better Auth `rateLimit` on sign-in/sign-up/reset; cookie cache ≤5 min if enabled (EC-7).
- [ ] Login brute-force throttled per IP and per account with uniform errors
- [ ] Sessions survive API restart (Redis + DB rows)
- [ ] Rate-limit counters in Redis, observable via logs/metrics
- [ ] **(v1.1, EC-19)** throttle on combined IP+account key (primarily IP); attacker-sourced fails escalate to step-up, never hard-lock the victim (test: victim still logs in from a trusted device under a flood)
- [ ] **(v1.2, EC-19)** trusted-device cookie **softens** account-level limits, never fully exempts (a stolen cookie must not be an unlimited-guessing token); cookie is account-bound and rotated on each successful login

### 1.15 Sessions & devices UI
`feat/web-sessions` · labels: `phase:1 area:web` · depends: 1.14
Account Settings → Sessions (Figma): list active sessions (IP, user agent, last active), revoke one, revoke all.
- [ ] Revoked device is signed out within cookie-cache maxAge
- [ ] "Revoke all others" keeps the current session alive
- [ ] Matches designed Account Settings frames

### 1.16 Audit log skeleton
`feat/audit-core` · labels: `phase:1 area:api area:db security` · depends: 1.10
`audit_logs` table (append-only grants), audit service, events for auth + membership actions (PRD §10.2 core set).
- [ ] Runtime role has INSERT/SELECT only on `audit_logs`
- [ ] Login success/failure, logout, invite, accept, role change, member removal all logged
- [ ] Written in the same transaction as the mutation where feasible
- [ ] **(v1.2)** `organization_id` is **nullable** — login/signup/limbo events have no org; pre-org auth events must be logged, not skipped or given a fabricated org id (PRD §3.2)

### 1.17 Tenant-isolation test suite
`test/tenant-isolation` · labels: `phase:1 test security` · depends: 1.10, 1.13
Automated matrix from PRD §14.1: every tenant table probed cross-tenant at API layer and (guard-disabled) at DB layer.
- [ ] Cross-tenant read/write via API → 403/404 for every tenant resource
- [ ] Same probes with guards stubbed out → blocked by RLS
- [ ] Runs in CI as a required check

---

## Phase 2 — Team hardening

### 2.1 MFA (TOTP + backup codes)
`feat/auth-mfa-totp` · labels: `phase:2 area:api area:web security` · depends: 1.15
`twoFactor` plugin: QR enrollment in Account Settings → Security, hashed backup codes, verify at sign-in.
- [ ] Enrollment, challenge-on-login, and backup-code redemption work end-to-end
- [ ] Enabling MFA revokes other sessions (EC-15)
- [ ] Secrets encrypted at rest; backup codes hashed, shown once
- [ ] **(v1.1, EC-25)** verify endpoint has its own tight rate limit (separate from login); replayed code within the same time step rejected; backup-code attempts throttled harder; failures escalate to step-up not a bare lock

### 2.2 Org security settings enforcement
`feat/org-security-settings` · labels: `phase:2 area:api area:web` · depends: 2.1, 1.13
Settings UI (designed) + OrgGuard enforcement of `mfa_required` (`403 MFA_ENROLLMENT_REQUIRED` → forced enrollment flow, 7-day grace) and `session_timeout_minutes` per PRD §4.4/§9.
- [ ] Non-enrolled member of an MFA-required org is funneled to enrollment
- [ ] Session older than org timeout rejected for that org only
- [ ] Setting changes audited
- [ ] **(v1.2)** `session_timeout_minutes` is an **absolute session-age cap** vs `createdAt` (not idle), validated to 15 min–30 days; do not approximate idle timeout with `updatedAt` (PRD §4.4)

### 2.3 Fresh-session step-up
`feat/auth-step-up` · labels: `phase:2 area:api area:web security` · depends: 1.9
`session.freshAge = 15m`, `@RequiresFreshSession()` decorator on sensitive endpoints, web re-auth modal that retries the original request (PRD §4.4, EC-4).
- [ ] 16-min-old session on a tagged endpoint → `401 SECURITY_CHALLENGE_REQUIRED`
- [ ] Re-auth (password / SSO / MFA) refreshes freshness and the action completes
- [ ] Applied to: role changes, API keys, billing, SSO/SCIM config, workspace deletion, data export
- [ ] **(v1.1, EC-23)** impersonation sessions hard-blocked from these endpoints — the impersonation flag is the gate, not the session timestamp (a support session can look "fresh")
- [ ] **(v1.2, EC-30)** SSO step-up forces IdP re-auth: `ForceAuthn="true"` (SAML) / `prompt=login`+`max_age=0` (OIDC); assertions predating the challenge rejected; silent SSO completion does **not** satisfy step-up; TOTP fallback if the IdP ignores forced re-auth

### 2.4 Password policy + breach checking
`feat/auth-password-policy` · labels: `phase:2 area:api security` · depends: 1.5
Min 12 chars, `haveIBeenPwned` plugin, no composition rules (PRD §4.2).
- [ ] Breached password rejected at signup and reset with clear copy
- [ ] Policy enforced server-side (client hints only cosmetic)

### 2.5 Account linking + email change
`feat/auth-account-linking` · labels: `phase:2 area:api security` · depends: 1.6
`accountLinking` with `trustedProviders: [google, microsoft]`, verified-email requirement, manual link/unlink in Account Settings; Better Auth two-step email change (PRD §4.5/§4.6).
- [ ] Verified same-email Google login links instead of erroring
- [ ] Unverified collision → conflict flow, no auto-link (EC-2)
- [ ] Email change confirms from the OLD address first, then verifies new; revokes other sessions

### 2.6 API keys
`feat/auth-api-keys` · labels: `phase:2 area:api security` · depends: 2.3, 1.13
`apiKey` plugin: org-scoped keys (`wo_live_…`), scopes in metadata, per-key rate limits, fresh-session-gated management UI (PRD §10.1).
- [ ] Key authenticates as service principal through OrgGuard with `actor_type = api_key`
- [ ] Shown once, hashed at rest, revocable; lifecycle audited
- [ ] Scopes enforced in place of role permissions
- [ ] **(v1.2, EC-29)** key scopes ⊆ creator's permissions at creation (admin cannot mint owner-scope keys); each key records its creator; auto-revoke creator's keys on removal/deprovision, suspend-for-review on demotion (departed admin must not retain API access)

### 2.7 Webhooks
`feat/webhooks` · labels: `phase:2 area:api` · depends: 1.16
Event emission + delivery worker per PRD §10.3: HMAC-SHA256 + timestamp header (5-min replay window), exponential retries, auto-disable, delivery log.
- [ ] `user.created`, `member.joined/removed`, `asset.assigned`, `employee.offboarded` emitted
- [ ] Signature verifiable with documented recipe; replayed payload rejected by sample verifier
- [ ] Background jobs carry `organizationId` and use scoped transactions (PRD §5 L3)
- [ ] **(v1.1, EC-26)** SSRF egress control: reject private/link-local/loopback/metadata targets (incl. `169.254.169.254`) at save + delivery; HTTPS only; no redirect following; re-validate resolved IP at connect (anti DNS-rebinding); minimize PII in payloads
- [ ] **(v1.2)** endpoints are org-scoped; only the subscribing org's events are ever delivered; `user.created` fires in org context at member-join (PRD §10.3)

### 2.8 Full audit coverage + audit UI
`feat/audit-ui` · labels: `phase:2 area:api area:web` · depends: 1.16
Extend to 100% write coverage (PRD §10.2 list) and build the in-app viewer (`audit:read`) with filters + export.
- [ ] Every mutating endpoint verified audited (test walks the route table)
- [ ] Retention setting (90–365d) with soft-delete purge job

### 2.9 GDPR export + account deletion
`feat/compliance-gdpr` · labels: `phase:2 area:api` · depends: 2.3, 1.13
Self-serve data export (fresh session) and deletion with 14-day grace; sole-owner deletion blocked until transfer (PRD §10.4, EC-3).
- [ ] Export delivers all personal data linked to the user
- [ ] **(v1.2)** export scope = requester's own personal data **only** — no org operational data, no other members' PII; audit entries filtered to the requester's actions with other actors pseudonymized (PRD §10.4)
- [ ] Deletion pseudonymizes audit `actor_user_id` instead of deleting rows
- [ ] Sole owner must transfer ownership or delete workspace first

---

## Phase 3 — Enterprise

### 3.1 SSO core (SAML 2.0 + OIDC)
`feat/sso-core` · labels: `phase:3 area:api area:web security` · depends: 2.2
`@better-auth/sso` plugin: per-org provider registration via the IdP Setup modal (designed — metadata upload / discovery URL), `organizationProvisioning` (`defaultRole: viewer`), `provisionUserOnEveryLogin` (PRD §7).
- [ ] SAML login against Okta dev + OIDC against Entra dev succeed
- [ ] Assertion signature/timestamp/audience validation verified; replayed assertion rejected
- [ ] SSO login auto-joins the provider's org as `viewer`

### 3.2 Domain verification (DNS TXT)
`feat/domain-verification` · labels: `phase:3 area:api area:web security` · depends: 1.8
`verified_domains` per PRD §6.5: TXT challenge, verification job, partial unique index on verified rows, public-domain blocklist (EC-9).
- [ ] `gmail.com` etc. rejected; punycode/lowercase normalization
- [ ] Second org cannot verify an already-claimed domain; losing TXT loses the claim
- [ ] Settings UI for add/verify/remove with status
- [ ] **(v1.2, EC-31)** claims expire: re-verification job checks TXT every 30 days (`last_checked_at`); missing record → 7-day grace + admin alerts → lapse suspends auto-join and SSO domain-routing until re-verified (existing members untouched)
- [ ] **(v1.2)** schema: **no** plain `UNIQUE(domain)` constraint (would block contested claims, contradicting EC-9) — uniqueness via the partial index on verified rows only (PRD §3.2)

### 3.3 Domain auto-join
`feat/domain-auto-join` · labels: `phase:3 area:api area:web` · depends: 3.2
Opt-in auto-join at max `auto_join_role` (default `viewer`) for verified-email signups matching a verified domain (PRD §6.5, EC-10).
- [ ] Matching signup sees "Join {Org}" instead of workspace creation
- [ ] Only verified emails; role capped at `auto_join_role`
- [ ] SSO-enforced orgs route domain matches straight into SSO (`defaultSSO`)
- [ ] **(v1.1/v1.2, EC-17 + EC-33)** applies only to zero-membership users; a user already in another org is not joined/moved — and there is **no admin-visible flag** (enumeration/privacy oracle); they simply never appear in the target org

### 3.4 Enforce SSO
`feat/sso-enforcement` · labels: `phase:3 area:api security` · depends: 3.1, 3.2
Enforcement per org at activation/guard time (EC-14): preconditions (verified domain + tested connection + owner SSO login), enable-time revocation of non-SSO org sessions, owner break-glass per open question #1 (PRD §7, EC-6).
- [ ] Password-holder cannot access an enforced org via password; enable-time revocation of non-SSO sessions
- [ ] Enabling requires a completed owner SSO test login
- [ ] Password reset cannot mint usable credential access to an enforced org
- [ ] **(v1.1, EC-24)** break-glass owner password login requires our TOTP MFA on top of the password (even when IdP MFA is trusted); break-glass logins audited + admin-alertable
- [ ] **(v1.2, EC-32)** enabling enforce-SSO with break-glass ON is **blocked until every owner has TOTP enrolled** (enable flow walks them through enrollment); an owner of an enforced org cannot remove their last TOTP factor while break-glass is ON

### 3.5 SCIM endpoints
`feat/scim` · labels: `phase:3 area:api security` · depends: 3.1
Custom NestJS `/scim/v2/*` per PRD §8: per-org hashed bearer tokens, email/`externalId` matching, verified-email link rule, idempotent create/patch, separate rate limits.
- [ ] Replayed create is a no-op; no constraint-collision faults
- [ ] Unverified-email match → 409 + admin flag (EC-2)
- [ ] Token rotation/revocation UI; `last_used_at` tracked; all ops audited (`actor_type = scim`)
- [ ] **(v1.1, EC-20)** match by `externalId` first, email as fallback; recycled email (new `externalId`) is a new identity, never a reattachment
- [ ] **(v1.1, EC-21)** email-change PATCH to an already-owned address → 409 + flag; never blind-UPDATE/merge
- [ ] **(v1.1, EC-17)** provisioning a user already in another org → 409 + flag; `one_org_per_user` index backstop
- [ ] **(v1.2)** `/scim/v2/*` accepts **bearer auth only** — session cookies ignored (cookie-honoring SCIM routes are CSRF-able); token compare constant-time via prefix lookup + timing-safe equality (PRD §8.1)

### 3.6 SCIM deprovision → offboarding
`feat/scim-offboarding` · labels: `phase:3 area:api` · depends: 3.5, 2.7
Deprovision flow per PRD §8.3: org-scoped session revocation (spare other orgs — EC-12), member removal, matching-employee asset-return trigger feeding Return Logs.
- [ ] Multi-org user keeps org-B access after org-A SCIM delete
- [ ] Matching employee record opens the return-logistics flow
- [ ] `user.deprovisioned` webhook emitted

### 3.7 Dynamic custom roles
`feat/rbac-dynamic-roles` · labels: `phase:3 area:api area:web` · depends: 1.13
`dynamicAccessControl` powering the designed "customize permissions per role" UI; custom roles cannot grant owner-only permissions (PRD §6.4).
- [ ] Org admin creates a custom role and assigns it; guards honor it immediately
- [ ] Owner-only permissions unassignable to custom roles

### 3.8 Support tooling — admin + impersonation
`feat/support-impersonation` · labels: `phase:3 area:api security` · depends: 2.8
`admin` plugin for internal support: lookup, session revocation, impersonation with banner, 30-min box, support-MFA, `actor_type = impersonation` audit, customer opt-out toggle (PRD §10.5).
- [ ] Impersonated session visibly bannered and time-boxed
- [ ] Every impersonation start/stop audited and org-visible
- [ ] **(v1.1, EC-23)** impersonation hard-blocked from every `@RequiresFreshSession()`/destructive endpoint (role changes, billing, SSO/SCIM config, API-key creation, workspace deletion, data export) — enforced by the guard flag, not freshness

### 2.10 Workspace lifecycle — ownership transfer, member leave, workspace deletion
`feat/workspace-lifecycle` · labels: `phase:2 area:api area:web security` · depends: 1.13, 2.2 · issue #36
PRD §6.6 (FR-19). Load-bearing under the single-org invariant: leaving is the only route to a different workspace, and EC-3's "sole owner can't delete" presumes transfer/deletion exists. Neither source spec covered it.
- [ ] Leave org (non-sole-owner) → org-less → onboarding limbo, free to create/accept anew; sessions rotated; assets flagged for return (EC-27)
- [ ] Ownership transfer: promote another member to `owner` / step down — transactional, `@RequiresFreshSession()`, audited, always ≥1 owner (EC-3)
- [ ] Sole owner blocked from leaving/deleting while other members exist until transfer
- [ ] Workspace deletion (owner-only, destructive): cascades members→limbo, voids invites, revokes sessions, cancels seats; in-flight assets to a wind-down path; name-to-confirm; soft-delete + grace; audited
- [ ] Mistaken-workspace escape: empty just-created workspace exposes delete-to-escape so a setup fat-finger can't trap the sole owner (EC-27)
- [ ] **(v1.2)** all membership exits (leave, removal, deprovision) are **hard deletes** of the member row — no `deleted_at` tombstones; exit history recorded in `audit_logs` (PRD §3.2/§8.3 decision)

---

## Cross-cutting definition of done (every card)
- [ ] Unit/integration tests for new logic; isolation suite (1.17) still green
- [ ] New endpoints behind AuthGuard/OrgGuard + permission checks; mutations audited
- [ ] `.env.example` and README updated for new config
- [ ] No secrets in code; errors follow the uniform/anti-enumeration rules where user-facing
