import { NextResponse } from "next/server";

import { requireSuperAdmin } from "@/lib/admin";
import { db } from "@/lib/db";
import { runTariffSync } from "@/lib/tariff-sync/sync";

// Fetch USITC (Chapter 99 diff → staged review items, base schedule →
// staged release) + Federal Register context, and return the per-part
// summary. POST = the admin "Sync now" button; GET = Vercel cron
// (vercel.json), which sends Authorization: Bearer CRON_SECRET.
export const maxDuration = 300;

async function sync() {
  const today = new Date().toISOString().slice(0, 10);
  const result = await runTariffSync(db, today);
  return NextResponse.json(result);
}

// Super-admin only (dev-open until SUPER_ADMIN_SECRET is set): syncing only
// stages review items, but it is a platform-operator action, not a tenant
// one.
export async function POST() {
  const denied = await requireSuperAdmin();
  if (denied) return denied;
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
