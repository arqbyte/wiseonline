# Technical Specifications v2: Multi-Tenant Authentication, Identity & Security Framework

**Target System:** Micro-Inventory & Asset Logistics Tracking Hub
**Core Stack:** Better Auth, TypeScript, PostgreSQL (Drizzle/Prisma), Standalone API
**Audience:** Enterprise IT Admins / Security Teams

---

# 1. Architecture Overview

* **Multi-tenant model:** Shared DB, strict `organization_id` isolation
* **Auth system:** Better Auth (OAuth, credentials, SAML)
* **Identity model:** User-centric with multi-account linking
* **Security model:** Defense-in-depth (middleware + DB RLS + audit)

---

# 2. Expanded Data Model

## 2.1 Organization Settings

```sql
CREATE TABLE "organization_settings" (
  "organization_id" TEXT PRIMARY KEY,
  "enforce_sso" BOOLEAN DEFAULT FALSE,
  "allow_email_login" BOOLEAN DEFAULT TRUE,
  "mfa_required" BOOLEAN DEFAULT FALSE,
  "session_timeout_minutes" INTEGER DEFAULT 10080,
  "created_at" TIMESTAMP NOT NULL
);
```

---

## 2.2 Role & Permission System (RBAC → ABAC-ready)

```sql
CREATE TABLE "roles" (
  "id" TEXT PRIMARY KEY,
  "organization_id" TEXT,
  "name" TEXT
);

CREATE TABLE "permissions" (
  "id" TEXT PRIMARY KEY,
  "key" TEXT UNIQUE
);

CREATE TABLE "role_permissions" (
  "role_id" TEXT,
  "permission_id" TEXT
);
```

**Examples:**

* `assets:read`
* `assets:write`
* `employees:offboard`
* `audit:read`

---

## 2.3 API Keys (Service Accounts)

```sql
CREATE TABLE "api_keys" (
  "id" TEXT PRIMARY KEY,
  "organization_id" TEXT,
  "name" TEXT,
  "hashed_key" TEXT,
  "scopes" TEXT[],
  "expires_at" TIMESTAMP,
  "created_at" TIMESTAMP
);
```

---

## 2.4 Verified Domains

```sql
CREATE TABLE "verified_domains" (
  "id" TEXT PRIMARY KEY,
  "organization_id" TEXT,
  "domain" TEXT UNIQUE,
  "verified" BOOLEAN DEFAULT FALSE
);
```

---

## 2.5 Audit Logging

```sql
CREATE TABLE "audit_logs" (
  "id" TEXT PRIMARY KEY,
  "organization_id" TEXT,
  "user_id" TEXT,
  "action" TEXT,
  "resource_type" TEXT,
  "resource_id" TEXT,
  "ip_address" TEXT,
  "user_agent" TEXT,
  "metadata" JSONB,
  "created_at" TIMESTAMP
);
```

---

## 2.6 MFA (TOTP)

```sql
CREATE TABLE "mfa_factors" (
  "id" TEXT PRIMARY KEY,
  "user_id" TEXT,
  "secret" TEXT,
  "backup_codes" TEXT[],
  "enabled" BOOLEAN
);
```

---

# 3. Authentication & Identity Layer

## 3.1 Supported Methods

* Email/password (verified only)
* Google OAuth
* Microsoft OAuth
* SAML SSO (enterprise)
* API keys (machine access)

---

## 3.2 Account Linking Rules

* Same email → link accounts
* Require `email_verified = TRUE`
* Conflict → manual resolution required

---

## 3.3 SSO Enforcement Logic

```typescript
if (orgSettings.enforceSso && provider !== "saml") {
  throw new Error("SSO_REQUIRED");
}
```

---

## 3.4 Domain-Based Auto Join

If:

* email domain matches verified domain

Then:

* auto-assign to org
* optionally enforce SSO

---

# 4. SCIM Provisioning (Enterprise)

## Required Endpoints

* `POST /scim/v2/Users`
* `PATCH /scim/v2/Users/:id`
* `DELETE /scim/v2/Users/:id`

## Rules

1. Match users by email
2. If exists:

   * attach SAML account
3. If not:

   * create user
4. If `email_verified = false` → reject

## Deprovision

* Disable user
* Revoke sessions
* Trigger asset return flow

---

# 5. Multi-Tenant Security Enforcement

## 5.1 Middleware (existing)

* Validates session
* Validates membership

## 5.2 Database Row-Level Security (MANDATORY)

```sql
ALTER TABLE assets ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation
ON assets
USING (organization_id = current_setting('app.current_org')::text);
```

---

## 5.3 Background Job Isolation

* Workers must receive `organization_id`
* Never run global queries without scoping

---

# 6. Session & Device Security

## 6.1 Session Rules

* Absolute expiry: 7 days
* Sliding refresh: 1 day
* Sensitive actions require fresh session (15 min)

## 6.2 Device Management (Required)

* List active sessions
* Revoke all sessions
* Track IP + device fingerprint

---

# 7. Security Controls

## 7.1 Rate Limiting

* Login attempts
* Invitation sends
* SCIM endpoints

## 7.2 MFA Enforcement

If org setting enabled:

* Block access until TOTP verified

---

## 7.3 Token Security

* Refresh token rotation
* Reuse detection → revoke all sessions

---

## 7.4 CSRF Protection

* Required for cookie-based auth

---

# 8. Audit & Observability

## Events to Track

* Login / logout
* Role changes
* Asset changes
* SSO enforcement toggles
* API key usage

---

# 9. Lifecycle Management

## 9.1 User States

* `active`
* `suspended`
* `deprovisioned`

---

## 9.2 Offboarding Flow

Triggered by:

* SCIM delete
* manual admin action

Actions:

1. revoke sessions
2. unassign assets
3. trigger return logistics

---

# 10. Invitations & Abuse Protection

* Expiry: 48 hours
* Rate-limited
* Domain validation (optional)
* Prevent duplicate invites

---

# 11. Compliance Layer

## 11.1 GDPR

* Data export endpoint
* Account deletion workflow

## 11.2 Retention

* Audit logs: configurable (e.g. 90–365 days)
* Soft delete before purge

---

## 11.3 Encryption

* At rest: managed DB encryption
* In transit: TLS 1.2+
* Optional field encryption for PII

---

# 12. Webhooks System

## Events

* `user.created`
* `user.deprovisioned`
* `asset.assigned`
* `employee.offboarded`

---

# 13. Billing Integration Hooks

* Seat counting via `member`
* Enforce limits at API layer
* Block actions if over quota

---

# 14. Edge Case Handling (Extended)

### 14.1 Account Collision

* Invite vs pre-existing user handled via invite lookup

### 14.2 SSO Migration

* Link existing verified users
* block unverified takeover

### 14.3 Orphaned Org

* Must always have ≥1 owner

### 14.4 Session Hijack

* Fresh-session enforcement

---

# 15. Non-Functional Requirements

* All queries must include `organization_id`
* No cross-tenant joins allowed
* 100% audit coverage on write actions
* Idempotent SCIM endpoints
* Zero trust between client and backend

---

# 16. Deployment Checklist

* RLS enabled on all tenant tables
* MFA tested
* SSO enforced scenarios validated
* Audit logs verified
* Rate limiting active
* Domain verification functional

---

# Final Assessment

This v2 spec upgrades the system from:

* **Startup-grade auth system**
  → to
* **Enterprise-ready identity platform**

It now satisfies:

* SOC2 expectations
* Enterprise SSO lifecycle
* Multi-tenant isolation guarantees
* Operational security requirements
