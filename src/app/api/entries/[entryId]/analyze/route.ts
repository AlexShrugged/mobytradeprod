import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";

import {
  AnalysisNotConfiguredError,
  runEntryAnalysis,
} from "@/lib/analysis/service";
import { db, schema } from "@/lib/db";
import { getCurrentOrgId } from "@/lib/org";

// One real model investigation, run synchronously — minutes, not seconds.
export const maxDuration = 800;

// Run (or re-run) the AI analyst over one entry. Claims the entry's pending
// queue row if a tariff apply left one, so a manual run also clears the
// "re-analysis queued" state.
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ entryId: string }> },
) {
  const { entryId } = await params;
  const orgId = await getCurrentOrgId();

  const entry = await db.query.entries.findFirst({
    where: and(eq(schema.entries.id, entryId), eq(schema.entries.orgId, orgId)),
    columns: { id: true },
  });
  if (!entry) {
    return NextResponse.json({ error: "Entry not found." }, { status: 404 });
  }

  try {
    const outcome = await runEntryAnalysis(db, orgId, entryId, "manual");
    return NextResponse.json({ outcome });
  } catch (err) {
    if (err instanceof AnalysisNotConfiguredError) {
      return NextResponse.json({ error: err.message }, { status: 503 });
    }
    throw err;
  }
}
