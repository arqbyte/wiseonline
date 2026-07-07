Here is the complete, production-ready engineering specifications document. You can copy and paste the markdown layout below directly into a Google Doc, Notion page, or feed it into **Claude Code** on Plan Mode.

It covers all structural requirements, multi-tenancy rules, explicit code logic, edge-case remediation protocols, and security principles.

---

# Technical Specifications: Multi-Tenant Authentication & Core Security Matrix

**Target System:** Micro-Inventory & Asset Logistics Tracking Hub

**Core Stack:** Better Auth, TypeScript, PostgreSQL (via Drizzle/Prisma), Standalone Custom Backend API

---

## 1. Relational Database Schema Architecture

The multi-tenant architecture utilizes a single, logically shared PostgreSQL instance. Data isolation is maintained via strict matching of `organization_id` (or `company_id`) constraints across all tables.

```sql
-- Core Authentication & Multi-Tenant Tables (Managed via Better Auth + Drizzle)

CREATE TABLE "user" (
  "id" TEXT PRIMARY KEY,
  "name" TEXT NOT NULL,
  "email" TEXT NOT NULL UNIQUE,
  "email_verified" BOOLEAN DEFAULT FALSE NOT NULL,
  "image" TEXT,
  "created_at" TIMESTAMP WITH TIME ZONE NOT NULL,
  "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL
);

CREATE TABLE "session" (
  "id" TEXT PRIMARY KEY,
  "expires_at" TIMESTAMP WITH TIME ZONE NOT NULL,
  "token" TEXT NOT NULL UNIQUE,
  "created_at" TIMESTAMP WITH TIME ZONE NOT NULL,
  "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL,
  "user_id" TEXT NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "active_organization_id" TEXT -- Cached token-level reference to the active org
);

CREATE TABLE "account" (
  "id" TEXT PRIMARY KEY,
  "user_id" TEXT NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "provider_id" TEXT NOT NULL, -- 'credential', 'google', 'microsoft', 'saml'
  "provider_account_id" TEXT NOT NULL,
  "password" TEXT, -- Hashed strictly using scrypt (Better Auth default)
  "access_token" TEXT,
  "refresh_token" TEXT,
  "id_token" TEXT,
  "expires_at" TIMESTAMP WITH TIME ZONE,
  "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL,
  CONSTRAINT "unique_provider_account" UNIQUE ("provider_id", "provider_account_id")
);

CREATE TABLE "organization" (
  "id" TEXT PRIMARY KEY,
  "name" TEXT NOT NULL,
  "slug" TEXT NOT NULL UNIQUE,
  "return_address" JSONB NOT NULL, -- Standard operational return depot destination
  "created_at" TIMESTAMP WITH TIME ZONE NOT NULL,
  "metadata" JSONB
);

CREATE TABLE "member" (
  "id" TEXT PRIMARY KEY,
  "organization_id" TEXT NOT NULL REFERENCES "organization"("id") ON DELETE CASCADE,
  "user_id" TEXT NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "role" TEXT NOT NULL DEFAULT 'admin', -- 'owner', 'admin', 'viewer'
  "created_at" TIMESTAMP WITH TIME ZONE NOT NULL
);

CREATE TABLE "invitation" (
  "id" TEXT PRIMARY KEY,
  "organization_id" TEXT NOT NULL REFERENCES "organization"("id") ON DELETE CASCADE,
  "email" TEXT NOT NULL,
  "role" TEXT NOT NULL DEFAULT 'admin',
  "token" TEXT NOT NULL UNIQUE,
  "expires_at" TIMESTAMP WITH TIME ZONE NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending', -- 'pending', 'accepted', 'revoked'
  "inviter_id" TEXT NOT NULL REFERENCES "user"("id") ON DELETE CASCADE
);

-- Core Operational Application Data Tables

CREATE TABLE "employees" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" TEXT NOT NULL REFERENCES "organization"("id") ON DELETE CASCADE,
  "name" TEXT NOT NULL,
  "email" TEXT NOT NULL,
  "shipping_address" JSONB,
  "status" TEXT NOT NULL DEFAULT 'active', -- 'active', 'offboarding', 'offboarded'
  "created_at" TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) not null
);

CREATE TABLE "assets" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" TEXT NOT NULL REFERENCES "organization"("id") ON DELETE CASCADE,
  "employee_id" TEXT REFERENCES "employees"("id") ON DELETE SET NULL, -- Nullable if sitting in internal stock
  "type" TEXT NOT NULL, -- 'laptop', 'monitor', 'phone', 'peripheral'
  "model" TEXT NOT NULL,
  "serial_number" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'available', -- 'available', 'assigned', 'pending_return', 'in_transit', 'pending_qa'
  "tracking_number" TEXT,
  "label_url" TEXT,
  "created_at" TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) not null
);

```

---

## 2. Better Auth Server Instantiation (API Code Block)

This block runs directly in your independent, standalone API layer runtime environment.

```typescript
import { betterAuth } from "better-auth";
import { organization } from "better-auth/plugins";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { db } from "./db"; // DB client import
import * as schema from "./schema";

export const auth = betterAuth({
  database: drizzleAdapter(db, { 
    provider: "pg",
    schema: schema
  }),
  emailAndPassword: { 
    enabled: true,
    requireEmailVerification: true // Mitigates early timing/spoofing vectors
  },
  socialProviders: {
    google: {
      clientId: process.env.GOOGLE_CLIENT_ID!,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
    },
    microsoft: {
      clientId: process.env.MICROSOFT_CLIENT_ID!,
      clientSecret: process.env.MICROSOFT_CLIENT_SECRET!,
    }
  },
  session: {
    expiresIn: 60 * 60 * 24 * 7, // Strict 7-Day Absolute Longevity Window
    updateAge: 60 * 60 * 24,     // Refresh token window sliding extension (1-Day)
  },
  plugins: [
    organization({
      roles: ["owner", "admin", "viewer"],
      defaultRole: "admin",
      creatorRole: "owner",
      allowUserToCreateOrganization: async ({ user }) => {
        // Enforce that only free-standing, unaffiliated profiles can spawn independent org nodes
        const existingMemberships = await db
          .select()
          .from(schema.member)
          .where(eq(schema.member.userId, user.id));
        return existingMemberships.length === 0;
      },
      invitationExpiresIn: 60 * 60 * 48, // Rigid 48-Hour Lifecycle validation window
    })
  ]
});

```

---

## 3. Custom Multi-Tenant Isolation Middleware

Every protected custom route handler endpoint executing logic outside Better Auth core controllers must pass incoming requests through this isolation pipeline layer.

```typescript
import { Request, Response, NextFunction } from "express";
import { auth } from "./auth";
import { db } from "./db";
import { member } from "./schema";
import { eq, and } from "drizzle-orm";

export interface AuthenticatedRequestContext extends Request {
  userId?: string;
  organizationId?: string;
  userRole?: string;
}

export async function multiTenantIsolationMiddleware(
  req: AuthenticatedRequestContext, 
  res: Response, 
  next: NextFunction
) {
  try {
    // 1. Recover stateless verification session token context via HTTP headers
    const session = await auth.api.getSession({ headers: req.headers });
    
    if (!session || !session.session) {
      return res.status(401).json({ error: "Authentication state invalid or expired." });
    }

    const userId = session.user.id;
    const activeOrgId = session.session.activeOrganizationId;

    if (!activeOrgId) {
      // Intercept and branch execution path to handle the "No Workspace/Limbo" UI state
      return res.status(200).json({
        status: "LIMIT_NO_WORKSPACE",
        message: "User identity verified but lacks active tenant association.",
        user: session.user
      });
    }

    // 2. Perform server-side runtime verification against manual tenant tampering (Bypassing spoofed headers)
    const membershipRecord = await db
      .select()
      .from(member)
      .where(
        and(
          eq(member.userId, userId),
          eq(member.organizationId, activeOrgId)
        )
      )
      .limit(1);

    if (membershipRecord.length === 0) {
      return res.status(403).json({ error: "Access Denied. Multi-tenant boundary violation." });
    }

    // 3. Bind validated context scopes to request payload pipeline
    req.userId = userId;
    req.organizationId = activeOrgId;
    req.userRole = membershipRecord[0].role;

    return next();
  } catch (error) {
    console.error("Critical Middleware Exception:", error);
    return res.status(500).json({ error: "Internal Gateway Boundary Failure." });
  }
}

```

---

## 4. Comprehensive Edge Case Remediation Matrix

### Edge Case 1: The "Limbo / Shared Personal Email Account" Collision

* **The Threat:** Independent registration by Person B (`engineer@gmail.com`) *prior* to consuming the active team invitation dispatched by Person A (`founder@gmail.com`).
* **Remediation Logic:** On API resolution of `LIMIT_NO_WORKSPACE`, your backend opens a search channel explicitly tracking open invitations targeting that text string.

```typescript
app.get("/api/onboarding/check-invites", async (req: AuthenticatedRequestContext, res: Response) => {
  const session = await auth.api.getSession({ headers: req.headers });
  if (!session) return res.status(401).json({ error: "Unauthenticated" });

  const pendingInvite = await db
    .select()
    .from(invitation)
    .where(
      and(
        eq(invitation.email, session.user.email),
        eq(invitation.status, "pending"),
        gt(invitation.expiresAt, new Date())
      )
    )
    .limit(1);

  if (pendingInvite.length > 0) {
    return res.status(200).json({ status: "INVITE_FOUND", invitation: pendingInvite[0] });
  }
  return res.status(200).json({ status: "NO_INVITES_FOUND" });
});

```

### Edge Case 2: Enterprise Identity Conversion & The Verified Hijack Trap

* **The Threat:** A legacy manual account (`admin@company.com`) exists via Google Workspace OAuth or standard passwords. Later, corporate IT configures a centralized SAML SSO/SCIM directory provisioning loop. When the automated sync payload lands, blind row creation will corrupt the database unique indexes or crash the engine. Alternatively, an unverified malicious actor attempts to register `ceo@company.com` to hijack the impending enterprise sync.
* **Remediation Logic:**
1. SCIM handlers must query by email address first. If a match occurs, verify if `email_verified` evaluates strictly to `TRUE`. If false, abort sync immediately and trigger an administrative flag.
2. If verified, the engine bypasses user generation and instead writes a brand new record to the `account` table matching the identical `user_id`, setting `provider_id = "saml"`.
3. **The SSO Enforcement Rule:** If the tenant settings record has `enforce_sso = true`, all traditional login endpoints must check the user profile. If they attempt to pass via legacy credential fields, drop the active cookie context immediately and redirect them out:



```typescript
if (organizationSettings.enforceSso && currentProviderId !== "saml") {
  return res.status(403).json({ error: "Corporate Security Compliance Policy Requires SAML SSO Login Authentication." });
}

```

### Edge Case 3: The Orphaned Tenant (Last Owner Safeguard)

* **The Threat:** An active administrator attempt to demote or remove the user record of the primary workspace `Owner`, or the sole owner clicks "Delete Account," leaving the company without an administrative head while financial billing runs silently.
* **Remediation Logic:** Inject an absolute data assertion check inside your membership mutation controllers:

```typescript
const ownerCount = await db
  .select()
  .from(member)
  .where(
    and(
      eq(member.organizationId, req.organizationId!),
      eq(member.role, "owner")
    )
  );

if (ownerCount.length <= 1 && targetMemberRoleChangeTo !== "owner") {
  return res.status(400).json({ error: "Operation Aborted. Workspace must maintain at least one active account with Owner privileges." });
}

```

### Edge Case 4: Strategic Session Destructive Verification (Fresh Session Check)

* **The Threat:** An administrative browser tab is left open in a shared physical environment, allowing unauthorized personnel to delete an asset row, alter bank details, or initiate fake physical delivery tracking return labels.
* **Remediation Logic:** For structural data alterations, parse the session creation timestamp. Better Auth tracks `session.createdAt`. If `Date.now() - session.createdAt > 15 minutes`, enforce a re-authentication flow before executing the controller:

```typescript
const freshWindow = 1000 * 60 * 15; // 15 Minute Boundary Rule
if (Date.now() - new Date(session.session.createdAt).getTime() > freshWindow) {
  return res.status(401).json({ 
    error: "SECURITY_CHALLENGE_REQUIRED", 
    message: "Sensitive administrative actions require immediate identity validation." 
  });
}

```

---

## 5. Summary Checklist for Code Construction (Plan Mode Execution)

When initializing the building phase inside Claude Code, verify that the following behaviors pass compilation unit test scripts perfectly:

1. **Logical Isolation Check:** Ensure no single application SQL statement reads from tables `assets` or `employees` without appending `WHERE organization_id = req.organizationId`.
2. **Stateless Signature Decoding:** Ensure that the custom backend runtime parses tokens via `Better Auth` cryptographic keys entirely in-memory, cutting down database roundtrip parsing delays for basic routing check routines.
3. **Verified Email Mandate:** Ensure that password recovery hooks or invitation claims require validation parameters before mapping records into multi-tenant workspace tables.
4. **SCIM Idempotency:** Ensure the synchronization endpoint cleanly runs account-linking matching loops without ever generating runtime constraint collision faults.