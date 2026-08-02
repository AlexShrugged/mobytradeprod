import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";

import { db, schema } from "@/lib/db";
import { getConnector } from "@/lib/integrations";
import { getCurrentOrgId } from "@/lib/org";

// "Run now" on a Data page source card: one on-demand intake pass through
// the source's connector. This route is the sole writer of the source's run
// telemetry (last_run_at / last_error / consecutive_failures) — connectors
// only do the I/O and report.
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ sourceId: string }> },
) {
  const { sourceId } = await params;
  const orgId = await getCurrentOrgId();

  const source = await db.query.integrationSources.findFirst({
    where: and(
      eq(schema.integrationSources.id, sourceId),
      eq(schema.integrationSources.orgId, orgId),
    ),
  });
  if (!source) {
    return NextResponse.json({ error: "Source not found." }, { status: 404 });
  }
  if (source.status !== "active") {
    return NextResponse.json(
      { error: `This source is ${source.status.replace("_", " ")}; only active sources can run.` },
      { status: 409 },
    );
  }

  const result = await getConnector(source.kind).runNow(source);

  const now = new Date();
  const [updated] = await db
    .update(schema.integrationSources)
    .set(
      result.ok
        ? {
            lastRunAt: now,
            lastError: null,
            consecutiveFailures: 0,
            updatedAt: now,
          }
        : {
            lastRunAt: now,
            lastError: result.message,
            consecutiveFailures: source.consecutiveFailures + 1,
            updatedAt: now,
          },
    )
    .where(eq(schema.integrationSources.id, source.id))
    .returning();

  return NextResponse.json(
    { source: updated, message: result.message },
    { status: result.ok ? 200 : 502 },
  );
}
