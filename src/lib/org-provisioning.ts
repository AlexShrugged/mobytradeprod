import { eq } from "drizzle-orm";
import { clerkClient } from "@clerk/nextjs/server";

import { db, schema } from "@/lib/db";

// First request from a Clerk Organization with no tenant row yet: create
// the org and its manual-upload intake source (the upload/register routes
// resolve it by kind). JIT rather than a webhook — no public-URL/svix
// setup, identical in dev/preview/prod, and no signed-in-before-webhook
// race. Race-safe via the clerk_org_id unique index + onConflictDoNothing.
export async function provisionOrgForClerkOrg(clerkOrgId: string) {
  // Network call BEFORE the transaction (PGlite is single-session; nothing
  // slow belongs inside a tx either way).
  const clerk = await clerkClient();
  const remote = await clerk.organizations.getOrganization({
    organizationId: clerkOrgId,
  });
  return db.transaction(async (tx) => {
    const [inserted] = await tx
      .insert(schema.orgs)
      .values({
        name: remote.name,
        clerkOrgId,
        // importerOfRecord is editable afterward via Settings → PATCH
        // /api/org; inboxAddress is provisioned with a real intake channel,
        // not here; actor names now come from Clerk.
        importerOfRecord: null,
        inboxAddress: null,
        defaultActorName: null,
      })
      .onConflictDoNothing({ target: schema.orgs.clerkOrgId })
      .returning();
    if (inserted) {
      await tx.insert(schema.integrationSources).values({
        orgId: inserted.id,
        kind: "manual_upload",
        name: "Manual upload",
        status: "active",
        config: {},
      });
      return inserted;
    }
    // Lost the race — the winner's row exists.
    const existing = await tx.query.orgs.findFirst({
      where: eq(schema.orgs.clerkOrgId, clerkOrgId),
    });
    if (!existing) {
      throw new Error(`Org provisioning race lost twice for ${clerkOrgId}`);
    }
    return existing;
  });
}
