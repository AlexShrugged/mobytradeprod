import { cache } from "react";
import { eq } from "drizzle-orm";
import { auth, currentUser } from "@clerk/nextjs/server";

import { clerkEnabled } from "@/lib/auth/config";
import { db, schema } from "@/lib/db";
import { provisionOrgForClerkOrg } from "@/lib/org-provisioning";

// The tenant seam. With Clerk enabled, the current org comes from the
// session's active Clerk Organization (JIT-provisioned on first sight);
// with Clerk disabled (local dev), the one seeded org. Callers are
// parameterless either way — queries and routes never change.

/** Thrown only when a request reaches tenant code without an authenticated
 *  organization — the proxy makes that unreachable for real traffic. */
export class OrgContextError extends Error {}

// React cache(): one lookup per RSC render pass, request-scoped — there is
// deliberately NO module-level cache (a warm serverless instance would pin
// the first tenant for every later request).
export const getCurrentOrg = cache(async () => {
  if (!clerkEnabled) {
    const org = await db.query.orgs.findFirst();
    if (!org) {
      throw new Error(
        "No organization found. Run `npm run db:seed` to create one.",
      );
    }
    return org;
  }
  const { userId, orgId } = await auth();
  if (!userId || !orgId) {
    throw new OrgContextError(
      "No authenticated organization on this request.",
    );
  }
  const org = await db.query.orgs.findFirst({
    where: eq(schema.orgs.clerkOrgId, orgId),
  });
  return org ?? provisionOrgForClerkOrg(orgId);
});

export async function getCurrentOrgId(): Promise<string> {
  return (await getCurrentOrg()).id;
}

// The human recorded as actor/decidedBy on manual edits and decisions —
// the authenticated Clerk user's display name, or the org's operator name
// in auth-disabled dev.
// Call OUTSIDE db.transaction: the dev fallback queries the global db
// handle, which deadlocks inside a tx on PGlite (single session).
export const getCurrentActorName = cache(async (): Promise<string> => {
  if (!clerkEnabled) {
    const org = await getCurrentOrg();
    return org.defaultActorName ?? org.name;
  }
  const user = await currentUser();
  if (!user) {
    throw new OrgContextError("No authenticated user on this request.");
  }
  const name =
    user.fullName ??
    [user.firstName, user.lastName].filter(Boolean).join(" ");
  return name || user.primaryEmailAddress?.emailAddress || "Unknown user";
});
