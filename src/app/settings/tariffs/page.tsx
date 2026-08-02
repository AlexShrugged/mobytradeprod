import Link from "next/link";
import { ArrowLeft, ExternalLink } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  getAnnouncements,
  getOpenRevisions,
  type AnnouncementSummary,
  type OpenRevision,
} from "@/lib/db/queries/tariffs";
import { formatDate, formatDateTime } from "@/lib/format";

import { RevisionReviewCard } from "./revision-review-card";

export const dynamic = "force-dynamic";

const SOURCE_LABEL: Record<string, string> = {
  usitc_hts: "USITC HTS",
  federal_register: "Federal Register",
  manual: "Manual",
};

export default async function TariffReviewPage() {
  const [revisions, announcements] = await Promise.all([
    getOpenRevisions(),
    getAnnouncements(),
  ]);

  // Group the queue by announcement, preserving the newest-first order.
  const groups: { announcement: OpenRevision["announcement"]; revisions: OpenRevision[] }[] = [];
  const groupByAnnouncement = new Map<string, (typeof groups)[number]>();
  for (const rev of revisions) {
    let group = groupByAnnouncement.get(rev.announcement.id);
    if (!group) {
      group = { announcement: rev.announcement, revisions: [] };
      groupByAnnouncement.set(rev.announcement.id, group);
      groups.push(group);
    }
    group.revisions.push(rev);
  }

  return (
    <div className="space-y-6">
      <div>
        <Link
          href="/settings"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:underline"
        >
          <ArrowLeft className="size-3.5" /> Settings
        </Link>
        <h1 className="mt-1 text-xl font-semibold tracking-tight">
          Tariff review queue
        </h1>
        <p className="text-sm text-muted-foreground">
          Chapter 99 changes staged by the sync. Nothing touches the duty math
          until a human approves and applies it; base-schedule refreshes apply
          directly and appear under recent announcements.
        </p>
      </div>

      {groups.length === 0 ? (
        <Card>
          <CardContent className="py-8 text-center text-sm text-muted-foreground">
            No revisions pending review — the Chapter 99 reference matches the
            latest fetched release.
          </CardContent>
        </Card>
      ) : (
        groups.map(({ announcement, revisions: group }) => (
          <section key={announcement.id} className="space-y-3">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <Badge variant="outline">
                {SOURCE_LABEL[announcement.source] ?? announcement.source}
              </Badge>
              <span className="font-medium">{announcement.title}</span>
              {announcement.publishedDate ? (
                <span className="text-muted-foreground">
                  {formatDate(announcement.publishedDate)}
                </span>
              ) : null}
              {announcement.url ? (
                <a
                  href={announcement.url}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-muted-foreground hover:underline"
                >
                  Source <ExternalLink className="size-3" />
                </a>
              ) : null}
            </div>
            {group.map((rev) => (
              <RevisionReviewCard key={rev.revisionId} revision={rev} />
            ))}
          </section>
        ))
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Recent announcements</CardTitle>
        </CardHeader>
        <CardContent>
          {announcements.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Nothing fetched yet — run a sync from Settings.
            </p>
          ) : (
            <ul className="divide-y">
              {announcements.map((a) => (
                <AnnouncementRow key={a.id} announcement={a} />
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function AnnouncementRow({
  announcement: a,
}: {
  announcement: AnnouncementSummary;
}) {
  const counts = a.revisions;
  const countBits = [
    counts.pending > 0 ? `${counts.pending} pending` : null,
    counts.approved > 0 ? `${counts.approved} approved` : null,
    counts.applied > 0 ? `${counts.applied} applied` : null,
    counts.rejected > 0 ? `${counts.rejected} rejected` : null,
    counts.superseded > 0 ? `${counts.superseded} superseded` : null,
  ].filter(Boolean);

  return (
    <li className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-2.5 text-sm">
      <Badge variant="outline" className="shrink-0">
        {SOURCE_LABEL[a.source] ?? a.source}
      </Badge>
      <span className="font-medium">
        {a.url ? (
          <a href={a.url} target="_blank" rel="noreferrer" className="hover:underline">
            {a.title}
          </a>
        ) : (
          a.title
        )}
      </span>
      <span className="text-xs text-muted-foreground">
        {formatDateTime(a.fetchedAt)}
      </span>
      {/* Diffstat for base refreshes; staging summary / abstract otherwise. */}
      {a.summary ? (
        <span className="w-full text-xs text-muted-foreground sm:w-auto">
          {a.summary}
        </span>
      ) : null}
      {countBits.length > 0 ? (
        <span className="text-xs text-muted-foreground">
          {countBits.join(" · ")}
        </span>
      ) : null}
      <Badge
        variant={a.status === "open" ? "default" : "secondary"}
        className="ml-auto shrink-0"
      >
        {a.status}
      </Badge>
    </li>
  );
}
