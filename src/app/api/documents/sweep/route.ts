import { NextResponse } from "next/server";
import { and, asc, eq, isNull, lt, or } from "drizzle-orm";

import { requireSuperAdmin } from "@/lib/admin";
import { db, schema } from "@/lib/db";
import { sha256Hex } from "@/lib/documents/content-hash";
import { isProdRuntime } from "@/lib/env";
import { processDocumentRow } from "@/lib/processing/run";
import { getFileStore } from "@/lib/storage";

// Sweep documents whose browser-driven processing never ran or never
// finished: "pending" rows (the tab closed before their turn in the upload
// batch) and "processing" rows untouched long enough that their runner is
// dead (a killed serverless function). POST = manual trigger (super-admin:
// it processes every org's documents); GET = Vercel cron (vercel.json),
// which sends Authorization: Bearer CRON_SECRET.
export const maxDuration = 800;

// A healthy run touches updatedAt when it claims the row and finishes well
// inside the route's own maxDuration — 15 minutes untouched means dead.
const STALE_PROCESSING_MS = 15 * 60 * 1000;

// Same pool size as the dropzone's processing pool, for the same reasons:
// provider rate limits and concurrent linker writes.
const CONCURRENCY = 3;

// Stop pulling new docs well before maxDuration so in-flight extractions
// (minutes each) can finish inside this invocation; leftovers keep their
// status and the next sweep picks them up.
const DEADLINE_MS = 180_000;

// Hash backfill: parent rows uploaded before content hashing existed get
// their SHA-256 here, oldest first, within a budget — the sweep runs with
// the store's own credentials, so the corpus is hashed in place. Once
// every parent carries a hash this leg finds nothing and costs one query.
// A file missing from the store is skipped (and retried next sweep).
const HASH_BUDGET_MS = 120_000;
const HASH_BATCH = 500;

async function backfillHashes(): Promise<{ hashed: number; unhashed: number }> {
  const rows = await db.query.documents.findMany({
    where: and(
      isNull(schema.documents.contentHash),
      isNull(schema.documents.parentDocumentId),
    ),
    columns: { id: true, storageKey: true },
    orderBy: asc(schema.documents.uploadedAt),
    limit: HASH_BATCH,
  });
  if (rows.length === 0) return { hashed: 0, unhashed: 0 };
  const store = getFileStore();
  const deadline = Date.now() + HASH_BUDGET_MS;
  let hashed = 0;
  for (const row of rows) {
    if (Date.now() >= deadline) break;
    let bytes: Buffer;
    try {
      bytes = await store.get(row.storageKey);
    } catch {
      continue;
    }
    await db
      .update(schema.documents)
      .set({ contentHash: sha256Hex(bytes) })
      .where(eq(schema.documents.id, row.id));
    hashed += 1;
  }
  return { hashed, unhashed: rows.length - hashed };
}

async function sweep() {
  const staleBefore = new Date(Date.now() - STALE_PROCESSING_MS);
  const docs = await db.query.documents.findMany({
    where: or(
      eq(schema.documents.status, "pending"),
      and(
        eq(schema.documents.status, "processing"),
        lt(schema.documents.updatedAt, staleBefore),
      ),
    ),
    orderBy: asc(schema.documents.createdAt),
  });

  const deadline = Date.now() + DEADLINE_MS;
  const queue = [...docs];
  let processed = 0;
  let failed = 0;
  let skipped = 0;
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
      for (let doc = queue.shift(); doc; doc = queue.shift()) {
        const outcome = await processDocumentRow(doc, {
          reclaimStaleBefore: staleBefore,
        });
        if (!outcome.claimed) skipped += 1;
        else if (outcome.ok) processed += 1;
        else failed += 1;
        if (Date.now() >= deadline) break;
      }
    }),
  );

  const hashes = await backfillHashes();

  return NextResponse.json({
    eligible: docs.length,
    processed,
    failed,
    skipped,
    remaining: docs.length - processed - failed - skipped,
    hashed: hashes.hashed,
    unhashed: hashes.unhashed,
  });
}

export async function POST() {
  // Cross-org: sweeps every tenant's documents — platform-operator only.
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
