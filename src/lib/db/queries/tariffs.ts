import "server-only";

import { and, count, desc, eq, inArray, isNotNull, isNull } from "drizzle-orm";

import { db, schema } from "@/lib/db";
import { getCurrentOrgId } from "@/lib/org";
import type {
  LiveMeasureSnapshot,
  ProposedMeasureChange,
  RevisionEvidence,
} from "@/lib/tariff-sync/types";

// ------------------------------------------------------------ status card

export type TariffStatus = {
  measureCount: number;
  authorityCount: number;
  measuresByAuthority: {
    authority: schema.MeasureAuthorityValue;
    count: number;
  }[];
  /** Current (valid_to null) base-schedule windows, chapters 1–97. */
  baseCodeCount: number;
  /** Chapter 99 measure lines (incl. exemption rows). */
  ch99RowCount: number;
  lastSyncAt: Date | null;
  openRevisionCount: number;
};

export async function getTariffStatus(): Promise<TariffStatus> {
  const orgId = await getCurrentOrgId();
  const [byAuthority, baseRows, ch99Rows, latestAnnouncement, openItems] =
    await Promise.all([
      db
        .select({
          authority: schema.tradeMeasures.authority,
          count: count(),
        })
        .from(schema.tradeMeasures)
        .groupBy(schema.tradeMeasures.authority),
      db
        .select({ count: count() })
        .from(schema.htsCodes)
        .where(
          and(
            isNull(schema.htsCodes.tradeMeasureId),
            isNull(schema.htsCodes.validTo),
          ),
        ),
      db
        .select({ count: count() })
        .from(schema.htsCodes)
        .where(isNotNull(schema.htsCodes.tradeMeasureId)),
      db.query.tariffAnnouncements.findFirst({
        orderBy: (t) => [desc(t.fetchedAt)],
        columns: { fetchedAt: true },
      }),
      db
        .select({ count: count() })
        .from(schema.reviewItems)
        .where(
          and(
            eq(schema.reviewItems.orgId, orgId),
            eq(schema.reviewItems.itemType, "tariff_measure_revision"),
            eq(schema.reviewItems.status, "pending"),
          ),
        ),
    ]);

  const measuresByAuthority = [...byAuthority].sort(
    (a, b) => b.count - a.count || a.authority.localeCompare(b.authority),
  );
  return {
    measureCount: measuresByAuthority.reduce((s, a) => s + a.count, 0),
    authorityCount: measuresByAuthority.length,
    measuresByAuthority,
    baseCodeCount: baseRows[0]?.count ?? 0,
    ch99RowCount: ch99Rows[0]?.count ?? 0,
    lastSyncAt: latestAnnouncement?.fetchedAt ?? null,
    openRevisionCount: openItems[0]?.count ?? 0,
  };
}

// ------------------------------------------------------------ review queue

export type OpenRevision = {
  reviewItemId: string;
  revisionId: string;
  changeType: schema.RevisionChangeTypeValue;
  ch99Code: string | null;
  authority: schema.MeasureAuthorityValue | null;
  proposed: ProposedMeasureChange;
  /** Evidence text + sail-clause highlights. The highlighted dates are
   *  EVIDENCE ONLY — the reviewer confirms them at approve time. */
  evidence: RevisionEvidence;
  /** Live measure state at diff time, for the side-by-side diff view. */
  liveSnapshot: LiveMeasureSnapshot | null;
  announcement: {
    id: string;
    source: schema.AnnouncementSourceValue;
    sourceRef: string;
    title: string;
    url: string | null;
    publishedDate: string | null;
  };
};

/** Pending Chapter 99 revisions for the review queue, newest announcement
 *  first, stable order within one. */
export async function getOpenRevisions(): Promise<OpenRevision[]> {
  const orgId = await getCurrentOrgId();
  const items = await db.query.reviewItems.findMany({
    where: and(
      eq(schema.reviewItems.orgId, orgId),
      eq(schema.reviewItems.itemType, "tariff_measure_revision"),
      eq(schema.reviewItems.status, "pending"),
    ),
  });
  if (items.length === 0) return [];

  const revisions = await db.query.measureRevisions.findMany({
    where: inArray(
      schema.measureRevisions.id,
      items.map((i) => i.subjectId),
    ),
    with: { announcement: true },
  });
  const itemByRevision = new Map(items.map((i) => [i.subjectId, i]));

  return revisions
    .filter((r) => r.appliedAt === null)
    .sort(
      (a, b) =>
        b.announcement.fetchedAt.getTime() - a.announcement.fetchedAt.getTime() ||
        (a.ch99Code ?? "").localeCompare(b.ch99Code ?? ""),
    )
    .map((r) => ({
      reviewItemId: itemByRevision.get(r.id)!.id,
      revisionId: r.id,
      changeType: r.changeType,
      ch99Code: r.ch99Code,
      authority: r.authority,
      proposed: r.proposed as ProposedMeasureChange,
      evidence: r.evidence as RevisionEvidence,
      liveSnapshot: r.liveSnapshot as LiveMeasureSnapshot | null,
      announcement: {
        id: r.announcement.id,
        source: r.announcement.source,
        sourceRef: r.announcement.sourceRef,
        title: r.announcement.title,
        url: r.announcement.url,
        publishedDate: r.announcement.publishedDate,
      },
    }));
}

// ------------------------------------------------------------ announcements

export type AnnouncementSummary = {
  id: string;
  source: schema.AnnouncementSourceValue;
  sourceRef: string;
  title: string;
  url: string | null;
  publishedDate: string | null;
  fetchedAt: Date;
  status: schema.AnnouncementStatusValue;
  /** Diffstat for base refreshes; staging summary / FR abstract otherwise. */
  summary: string | null;
  /** Revision counts by state (all zero for FR notices and base refreshes —
   *  those carry no staged revisions). */
  revisions: {
    pending: number;
    approved: number;
    applied: number;
    rejected: number;
    superseded: number;
  };
};

export async function getAnnouncements(limit = 12): Promise<AnnouncementSummary[]> {
  const announcements = await db.query.tariffAnnouncements.findMany({
    orderBy: (t) => [desc(t.fetchedAt)],
    limit,
    with: { revisions: { columns: { id: true, appliedAt: true } } },
  });

  const revisionIds = announcements.flatMap((a) => a.revisions.map((r) => r.id));
  const items =
    revisionIds.length > 0
      ? await db.query.reviewItems.findMany({
          where: and(
            eq(schema.reviewItems.itemType, "tariff_measure_revision"),
            inArray(schema.reviewItems.subjectId, revisionIds),
          ),
          columns: { subjectId: true, status: true },
        })
      : [];
  const itemByRevision = new Map(items.map((i) => [i.subjectId, i]));

  return announcements.map((a) => {
    const counts = {
      pending: 0,
      approved: 0,
      applied: 0,
      rejected: 0,
      superseded: 0,
    };
    for (const r of a.revisions) {
      if (r.appliedAt) {
        counts.applied += 1;
        continue;
      }
      const status = itemByRevision.get(r.id)?.status;
      if (status && status in counts) {
        counts[status as keyof typeof counts] += 1;
      }
    }
    return {
      id: a.id,
      source: a.source,
      sourceRef: a.sourceRef,
      title: a.title,
      url: a.url,
      publishedDate: a.publishedDate,
      fetchedAt: a.fetchedAt,
      status: a.status,
      summary: a.summary,
      revisions: counts,
    };
  });
}
