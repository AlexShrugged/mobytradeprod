import { db } from "@/lib/db";

// v1 is single-tenant: every query is scoped to the one seeded org. When auth
// (Clerk) lands, this becomes a lookup from the authenticated session's
// organization — callers never need to change.
//
// The id is cached for the process lifetime — restart the dev server after
// `db:reset` (the reseeded org gets a new id).
let cachedOrgId: string | null = null;

export async function getCurrentOrgId(): Promise<string> {
  if (cachedOrgId) return cachedOrgId;
  const org = await db.query.orgs.findFirst();
  if (!org) {
    throw new Error(
      "No organization found. Run `npm run db:seed` to create one.",
    );
  }
  cachedOrgId = org.id;
  return org.id;
}

export async function getCurrentOrg() {
  const org = await db.query.orgs.findFirst();
  if (!org) {
    throw new Error(
      "No organization found. Run `npm run db:seed` to create one.",
    );
  }
  return org;
}

// The human recorded as actor/decidedBy on manual edits and decisions. v1
// has exactly one — the operator named on the org row (seeded data, never a
// source-code literal). When auth (Clerk) lands, this becomes the
// authenticated user's display name — callers never need to change.
// Call OUTSIDE db.transaction: a global-db query inside a tx deadlocks on
// PGlite (single session — the tx holds its lock).
export async function getCurrentActorName(): Promise<string> {
  const org = await getCurrentOrg();
  return org.defaultActorName ?? org.name;
}
