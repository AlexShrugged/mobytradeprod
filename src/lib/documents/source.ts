import "server-only";

import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { db, schema } from "@/lib/db";

const sourceIdSchema = z.uuid();

// Which intake channel delivered a batch of files. Callers wiring an
// automated channel pass its sourceId; the browser dropzone passes nothing
// and gets the org's manual-upload source row (null if none exists — the
// column tolerates unknown provenance). Shared by the server upload route
// and the client-direct register route.
export async function resolveSourceId(
  orgId: string,
  rawSourceId: string | null,
): Promise<{ ok: true; sourceId: string | null } | { ok: false; error: string }> {
  if (rawSourceId !== null && rawSourceId !== "") {
    const parsed = sourceIdSchema.safeParse(rawSourceId);
    if (!parsed.success) {
      return { ok: false, error: "Invalid sourceId." };
    }
    const source = await db.query.integrationSources.findFirst({
      where: and(
        eq(schema.integrationSources.id, parsed.data),
        eq(schema.integrationSources.orgId, orgId),
      ),
      columns: { id: true },
    });
    if (!source) {
      return { ok: false, error: "Unknown integration source." };
    }
    return { ok: true, sourceId: source.id };
  }
  const manual = await db.query.integrationSources.findFirst({
    where: and(
      eq(schema.integrationSources.orgId, orgId),
      eq(schema.integrationSources.kind, "manual_upload"),
    ),
    columns: { id: true },
  });
  return { ok: true, sourceId: manual?.id ?? null };
}
