import { NextResponse } from "next/server";

import { db } from "@/lib/db";
import { getCurrentOrgId } from "@/lib/org";
import { runTariffSync } from "@/lib/tariff-sync/sync";

// Fetch USITC (Chapter 99 diff → staged review items, base schedule →
// direct windowed refresh) + Federal Register context, and return the
// per-part summary. POST = the Settings "Sync now" button; GET = Vercel
// cron (vercel.json), which sends Authorization: Bearer CRON_SECRET.
export const maxDuration = 300;

async function sync() {
  const orgId = await getCurrentOrgId();
  const today = new Date().toISOString().slice(0, 10);
  const result = await runTariffSync(db, orgId, today);
  return NextResponse.json(result);
}

// No auth on POST — the app has no auth layer yet (single-org shim), and
// every mutation route shares that posture.
export async function POST() {
  return sync();
}

export async function GET(request: Request) {
  // The Bearer check is skipped when CRON_SECRET is unset (local dev has no
  // cron secret); production sets it, so unauthenticated GETs 401 there.
  const secret = process.env.CRON_SECRET;
  if (secret && request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }
  return sync();
}
