import "server-only";

import { and, count, desc, eq, inArray, isNotNull, isNull } from "drizzle-orm";

import { db, schema } from "@/lib/db";
import type {
  BaseReleaseProposalDisplay,
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
      // Global truth: the tariff queue has no org (super admin approves for
      // every tenant at once).
      db
        .select({ count: count() })
        .from(schema.reviewItems)
        .where(
          and(
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
  const items = await db.query.reviewItems.findMany({
    where: and(
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

// ------------------------------------------------------------ adoption groups

export type OpenGroupMember = {
  revisionId: string;
  ch99Code: string | null;
  name: string;
  rate: number | null;
  /** Raw rate text for non-ad-valorem measures (rate null, presence-only). */
  rateText: string | null;
  exemption: boolean;
  countries: string[] | null;
  countriesExcluded: string[] | null;
  effectiveDate: string | null;
  /** Extraction confidence chips for the member row (absent for stub-less
   *  or pre-extraction stagings). */
  extraction?: import("@/lib/tariff-sync/extractor/types").MeasureExtraction;
};

export type OpenMeasureGroup = {
  reviewItemId: string;
  groupId: string;
  title: string;
  authority: schema.MeasureAuthorityValue;
  ch99Prefix: string;
  /** Live members (not applied, not superseded) — derived at read time so
   *  a card superseded down to nothing shrinks instead of lying. */
  members: OpenGroupMember[];
  announcement: {
    id: string;
    source: schema.AnnouncementSourceValue;
    sourceRef: string;
    title: string;
    url: string | null;
    publishedDate: string | null;
  };
  fetchedAt: Date;
};

/** Pending wholesale-adoption groups with their live members, newest
 *  announcement first. */
export async function getOpenMeasureGroups(): Promise<OpenMeasureGroup[]> {
  const items = await db.query.reviewItems.findMany({
    where: and(
      eq(schema.reviewItems.itemType, "tariff_measure_group"),
      eq(schema.reviewItems.status, "pending"),
    ),
  });
  if (items.length === 0) return [];

  const groups = await db.query.measureRevisionGroups.findMany({
    where: inArray(
      schema.measureRevisionGroups.id,
      items.map((i) => i.subjectId),
    ),
    with: { announcement: true },
  });
  const itemByGroup = new Map(items.map((i) => [i.subjectId, i]));

  const members = await db.query.measureRevisions.findMany({
    where: and(
      inArray(
        schema.measureRevisions.groupId,
        groups.map((g) => g.id),
      ),
      isNull(schema.measureRevisions.appliedAt),
      isNull(schema.measureRevisions.supersededAt),
    ),
  });
  const membersByGroup = new Map<string, typeof members>();
  for (const m of members) {
    if (!m.groupId) continue;
    const list = membersByGroup.get(m.groupId) ?? [];
    list.push(m);
    membersByGroup.set(m.groupId, list);
  }

  return groups
    .map((g) => ({
      reviewItemId: itemByGroup.get(g.id)!.id,
      groupId: g.id,
      title: g.title,
      authority: g.authority,
      ch99Prefix: g.ch99Prefix,
      members: (membersByGroup.get(g.id) ?? [])
        .sort((a, b) => (a.ch99Code ?? "").localeCompare(b.ch99Code ?? ""))
        .map((m) => {
          const proposed = m.proposed as ProposedMeasureChange;
          const evidence = m.evidence as RevisionEvidence;
          return {
            revisionId: m.id,
            ch99Code: m.ch99Code,
            name: proposed.name,
            rate: proposed.rate,
            rateText: proposed.rateText ?? null,
            exemption: proposed.exemption,
            countries: proposed.countries,
            countriesExcluded: proposed.countriesExcluded ?? null,
            effectiveDate: proposed.effectiveDate,
            extraction: evidence.extraction,
          };
        }),
      announcement: {
        id: g.announcement.id,
        source: g.announcement.source,
        sourceRef: g.announcement.sourceRef,
        title: g.announcement.title,
        url: g.announcement.url,
        publishedDate: g.announcement.publishedDate,
      },
      fetchedAt: g.announcement.fetchedAt,
    }))
    .filter((g) => g.members.length > 0)
    .sort((a, b) => b.fetchedAt.getTime() - a.fetchedAt.getTime());
}

// ------------------------------------------------------------ base releases

export type OpenBaseRelease = {
  reviewItemId: string;
  announcementId: string;
  proposal: BaseReleaseProposalDisplay;
  fetchedAt: Date;
  title: string;
  url: string | null;
};

/** Pending base-schedule releases (release-level approval units), newest
 *  first. At most one is ever actionable — staging supersedes older ones —
 *  but the list shape keeps the UI honest if that invariant slips. */
export async function getOpenBaseReleases(): Promise<OpenBaseRelease[]> {
  const items = await db.query.reviewItems.findMany({
    where: and(
      eq(schema.reviewItems.itemType, "tariff_base_release"),
      eq(schema.reviewItems.status, "pending"),
    ),
  });
  if (items.length === 0) return [];

  const announcements = await db.query.tariffAnnouncements.findMany({
    where: inArray(
      schema.tariffAnnouncements.id,
      items.map((i) => i.subjectId),
    ),
  });
  const announcementById = new Map(announcements.map((a) => [a.id, a]));

  return items
    .map((item) => {
      const a = announcementById.get(item.subjectId);
      if (!a) return null;
      return {
        reviewItemId: item.id,
        announcementId: a.id,
        proposal: item.proposal as BaseReleaseProposalDisplay,
        fetchedAt: a.fetchedAt,
        title: a.title,
        url: a.url,
      };
    })
    .filter((r): r is OpenBaseRelease => r !== null)
    .sort((a, b) => b.fetchedAt.getTime() - a.fetchedAt.getTime());
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
