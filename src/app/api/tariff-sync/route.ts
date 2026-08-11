import { NextResponse } from "next/server";

import { requireSuperAdmin } from "@/lib/admin";
import { db } from "@/lib/db";
import { isProdRuntime } from "@/lib/env";
import { runTariffSync } from "@/lib/tariff-sync/sync";

// Fetch USITC (Chapter 99 diff → staged review items, base schedule →
// staged release) + Federal Register context, and return the per-part
// summary. POST = the admin "Sync now" button; GET = Vercel cron
// (vercel.json), which sends Authorization: Bearer CRON_SECRET.
export const maxDuration = 800;

async function sync() {
  const today = new Date().toISOString().slice(0, 10);
  const result = await runTariffSync(db, today);
  return NextResponse.json(result);
}

// Super-admin only (allowlist-gated once Clerk is on): syncing only stages
// review items, but it is a platform-operator action, not a tenant one.
export async function POST() {
  const denied = await requireSuperAdmin();
  if (denied) return denied;
  return sync();
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
  return sync();
}
