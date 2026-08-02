import "server-only";

import { asc, eq } from "drizzle-orm";

import { db, schema } from "@/lib/db";
import { getCurrentOrgId } from "@/lib/org";
import type { IntegrationSource } from "@/lib/db/schema";

// The Data page's source cards. Ordered by kind (enum order: manual_upload,
// sftp, email_inbox, erp) then name, so the cards render in a stable stack.
export async function getIntegrationSources(): Promise<IntegrationSource[]> {
  const orgId = await getCurrentOrgId();
  return db.query.integrationSources.findMany({
    where: eq(schema.integrationSources.orgId, orgId),
    orderBy: [
      asc(schema.integrationSources.kind),
      asc(schema.integrationSources.name),
    ],
  });
}
