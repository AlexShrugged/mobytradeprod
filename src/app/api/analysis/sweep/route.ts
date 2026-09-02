import { NextResponse } from "next/server";

import { requireSuperAdmin } from "@/lib/admin";
import {
  failAbandonedRuns,
  processPendingAnalyses,
  queueAnalysesForUnanalyzedEntries,
} from "@/lib/analysis/service";
import { db } from "@/lib/db";
import { isProdRuntime } from "@/lib/env";

// The AI analysis queue's runner — what makes analysis automatic. Each pass:
// reclaim runs whose runner died (a function cut off at its timeout, a
// deploy) and re-queue them; seed a first analysis for every entry that has
// none; then drain pending rows, oldest first, within a claim budget so
// every investigation started here finishes inside this invocation. Pending
// rows the processing hooks touched within the settle window wait for the
// next pass, so a packet's parts all land before the analyst looks. POST =
// manual trigger (super-admin: every org's entries); GET = Vercel cron
// (vercel.json, every 10 minutes), Authorization: Bearer CRON_SECRET.
export const maxDuration = 800;

// A healthy run finishes inside the analyst's 600s deadline plus IO; 20
// minutes in "running" means the runner is gone.
const STALE_RUNNING_MS = 20 * 60 * 1000;

// Packet children process sequentially after the parent (7501 then CI);
// three minutes of quiet means the entry's documents have settled.
const SETTLE_MS = 3 * 60 * 1000;

// Claim new rows only in the first 150s: 150s + the 600s analyst deadline
// + reconcile IO stays under maxDuration, so nothing here gets killed
// mid-investigation. Overlapping invocations are safe — claims are guarded.
const CLAIM_BUDGET_MS = 150_000;

// Parallel investigations — Anthropic rate limits and the pooled Neon
// connection budget, same reasoning as the document sweep.
const CONCURRENCY = 3;

// Rows considered per pass; the budget usually binds first.
const LIMIT = 12;

async function sweep() {
  const reclaimed = await failAbandonedRuns(db, {
    olderThanMs: STALE_RUNNING_MS,
    requeue: true,
  });
  const seeded = await queueAnalysesForUnanalyzedEntries(db);
  const drained = await processPendingAnalyses(db, {
    limit: LIMIT,
    concurrency: CONCURRENCY,
    budgetMs: CLAIM_BUDGET_MS,
    settleMs: SETTLE_MS,
  });
  return NextResponse.json({ reclaimed, seeded, ...drained });
}

export async function POST() {
  // Cross-org: runs every tenant's queue — platform-operator only.
  const denied = await requireSuperAdmin();
  if (denied) return denied;
  return sweep();
}

export async function GET(request: Request) {
  // Cron auth. Local dev keeps the open GET for manual testing; on Vercel
  // an unset CRON_SECRET is a misconfiguration, not permission — fail
  // closed. Vercel attaches the Bearer automatically once the env var
  // exists.
  const secret = process.env.CRON_SECRET;
  if (!secret && isProdRuntime()) {
    return NextResponse.json(
      { error: "CRON_SECRET is not configured." },
      { status: 500 },
    );
  }
  if (secret && request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }
  return sweep();
}
