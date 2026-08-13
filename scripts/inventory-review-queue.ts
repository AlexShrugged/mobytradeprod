// Read-only inventory of the tariff review queue: every pending review item
// by type, with enough proposal detail to judge whether a bulk approval can
// apply it (create_measure needs an effective date; base releases need a
// clean sanity guard).
//
// Run: DATABASE_URL=postgres://... npx tsx scripts/inventory-review-queue.ts
// tsx runs this as CJS — no top-level await; everything lives in main().

import { and, eq, inArray, isNull } from "drizzle-orm";

// Relative imports on purpose: tsx does not resolve the `@/` alias here.
import { db, schema } from "../src/lib/db";
import type { ProposedMeasureChange } from "../src/lib/tariff-sync/types";

async function main() {
  const pending = await db.query.reviewItems.findMany({
    where: eq(schema.reviewItems.status, "pending"),
  });
  const byType = new Map<string, typeof pending>();
  for (const item of pending) {
    (byType.get(item.itemType) ?? byType.set(item.itemType, []).get(item.itemType)!).push(item);
  }
  console.log("Pending review items by type:");
  for (const [type, items] of byType) console.log(`  ${type}: ${items.length}`);
  if (pending.length === 0) console.log("  (queue is empty)");

  // --- Chapter 99 revisions -------------------------------------------------
  const revItems = byType.get("tariff_measure_revision") ?? [];
  if (revItems.length > 0) {
    const revisions = await db.query.measureRevisions.findMany({
      where: inArray(
        schema.measureRevisions.id,
        revItems.map((i) => i.subjectId),
      ),
      with: { announcement: true },
    });
    console.log(`\n=== Chapter 99 revisions (${revisions.length}) ===`);
    for (const r of revisions) {
      if (r.appliedAt) continue;
      const p = r.proposed as ProposedMeasureChange;
      const missing =
        r.changeType === "create_measure" && !p.effectiveDate
          ? "  ** MISSING EFFECTIVE DATE — will be skipped **"
          : "";
      console.log(
        `- [${r.changeType}] ${r.ch99Code ?? "?"} ${p.name ?? ""} | ${r.authority} | eff=${p.effectiveDate ?? "null"} end=${p.endDate ?? "null"} rate=${p.rate ?? p.rateText ?? "null"} countries=${p.countries?.join("/") ?? "all"} prefixes=${p.prefixes?.length ?? 0} | src: ${r.announcement.sourceRef}${missing}`,
      );
    }
  }

  // --- adoption groups ------------------------------------------------------
  const groupItems = byType.get("tariff_measure_group") ?? [];
  if (groupItems.length > 0) {
    const groups = await db.query.measureRevisionGroups.findMany({
      where: inArray(
        schema.measureRevisionGroups.id,
        groupItems.map((i) => i.subjectId),
      ),
      with: { announcement: true },
    });
    console.log(`\n=== Adoption groups (${groups.length}) ===`);
    for (const g of groups) {
      const members = await db.query.measureRevisions.findMany({
        where: and(
          eq(schema.measureRevisions.groupId, g.id),
          isNull(schema.measureRevisions.appliedAt),
          isNull(schema.measureRevisions.supersededAt),
        ),
      });
      const noDate = members.filter(
        (m) => !(m.proposed as ProposedMeasureChange).effectiveDate,
      );
      console.log(
        `- ${g.authority} ${g.ch99Prefix}* | ${members.length} live members, ${noDate.length} without an effective date${noDate.length > 0 ? " ** group will be skipped unless dates are supplied **" : ""} | src: ${g.announcement.sourceRef}`,
      );
    }
  }

  // --- base releases --------------------------------------------------------
  const baseItems = byType.get("tariff_base_release") ?? [];
  if (baseItems.length > 0) {
    const announcements = await db.query.tariffAnnouncements.findMany({
      where: inArray(
        schema.tariffAnnouncements.id,
        baseItems.map((i) => i.subjectId),
      ),
    });
    console.log(`\n=== Base-schedule releases (${announcements.length}) ===`);
    for (const item of baseItems) {
      const a = announcements.find((x) => x.id === item.subjectId);
      console.log(
        `- ${a?.title ?? item.subjectId} | proposal: ${JSON.stringify(item.proposal)?.slice(0, 300) ?? "none"}`,
      );
    }
  }

  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
