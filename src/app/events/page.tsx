import Link from "next/link";
import { CalendarClock, Ship } from "lucide-react";

import { EventRow } from "@/components/events/event-row";
import { Money } from "@/components/money";
import { PageHeader } from "@/components/page-header";
import { SailBasisBadge } from "@/components/sail-basis";
import { StatusBadge } from "@/components/status-badge";
import { Badge } from "@/components/ui/badge";
import { getEvents } from "@/lib/db/queries/events";
import { getFutureEntries } from "@/lib/db/queries/entries";
import { groupByDay } from "@/lib/events/assemble";
import {
  EVENT_FILTER_GROUPS,
  typesForGroup,
  type EventFilterGroup,
} from "@/lib/events/types";
import { formatDate } from "@/lib/format";
import { cn } from "@/lib/utils";

export const dynamic = "force-dynamic";

const CHIP_LABELS: Record<EventFilterGroup, string> = {
  entries: "Entries",
  shipments: "Shipments",
  pos: "POs",
  invoices: "Invoices",
  quotes: "Quotes",
  classification: "Classification",
  refunds: "Refunds",
  edits: "Edits",
};

function dayLabel(day: string, today: string, yesterday: string): string {
  if (day === today) return "Today";
  if (day === yesterday) return "Yesterday";
  return formatDate(day);
}

// The chronological feed of what's changing in the business, ordered by when
// each event ACTUALLY occurred (a late-uploaded BOL sorts by its sail date).
// Filters are URL params so the page stays a server component.
export default async function EventsPage({
  searchParams,
}: {
  searchParams: Promise<{ type?: string; sku?: string }>;
}) {
  const params = await searchParams;
  const group =
    params.type && params.type in EVENT_FILTER_GROUPS
      ? (params.type as EventFilterGroup)
      : null;
  const partId = params.sku;

  const [events, futureEntries] = await Promise.all([
    getEvents({ types: typesForGroup(group), partId }),
    // Upcoming only on the unfiltered/entries views — projections are not
    // events and stay out of scoped or narrow feeds.
    !partId && (group === null || group === "entries")
      ? getFutureEntries()
      : Promise.resolve([]),
  ]);

  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const yesterday = new Date(now.getTime() - 86_400_000)
    .toISOString()
    .slice(0, 10);
  const dayGroups = groupByDay(events);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Events"
        info="Every change in your import business, in the order it happened. Expand an event for source documents and who made the change."
      />

      <div className="flex flex-wrap items-center gap-1.5">
        <FilterChip href="/events" active={group === null && !partId}>
          All
        </FilterChip>
        {(Object.keys(CHIP_LABELS) as EventFilterGroup[]).map((g) => (
          <FilterChip key={g} href={`/events?type=${g}`} active={group === g}>
            {CHIP_LABELS[g]}
          </FilterChip>
        ))}
        {partId ? (
          <Badge variant="secondary" className="ml-2 font-normal">
            Filtered to one SKU ·{" "}
            <Link href="/events" className="underline underline-offset-2">
              clear
            </Link>
          </Badge>
        ) : null}
      </div>

      {futureEntries.length > 0 ? (
        <section className="space-y-2">
          <h2 className="flex items-center gap-1.5 text-sm font-medium text-muted-foreground">
            <CalendarClock className="size-4" /> Upcoming
          </h2>
          <div className="grid gap-3 sm:grid-cols-2">
            {futureEntries.map((fe) => (
              <div
                key={fe.id}
                className="rounded-lg border border-dashed border-amber-500/40 bg-amber-500/5 p-4"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="flex items-center gap-1.5 text-sm font-medium">
                    <Ship className="size-4" /> {fe.shipmentNumber}
                  </span>
                  <StatusBadge status="projected" />
                </div>
                <div className="mt-2 space-y-1 text-sm">
                  <div className="flex justify-between gap-4">
                    <span className="text-muted-foreground">
                      Projected entry
                    </span>
                    <span>
                      {fe.projectedEntryDate
                        ? `~${formatDate(fe.projectedEntryDate)}`
                        : "—"}
                      {fe.portOfEntry ? ` · ${fe.portOfEntry}` : ""}
                    </span>
                  </div>
                  <div className="flex justify-between gap-4">
                    <span className="text-muted-foreground">Est. duties</span>
                    <Money cents={fe.estimatedDutiesCents} estimate tone="duty" />
                  </div>
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  <SailBasisBadge basis={fe.sailBasis} />
                  {fe.deadline ? (
                    <Badge
                      variant="outline"
                      className="border-amber-500/20 bg-amber-500/10 font-normal text-amber-700 dark:text-amber-400"
                      title={`${fe.deadline.measureName}: exempt only if entered by this date`}
                    >
                      exempt if entered by {formatDate(fe.deadline.enteredBy)}
                    </Badge>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {dayGroups.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No events match this filter yet.
        </p>
      ) : (
        <div className="space-y-4">
          {dayGroups.map(({ day, events: dayEvents }) => (
            <section key={day}>
              <h2 className="sticky top-14 z-10 -mx-1 bg-background/95 px-1 py-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground backdrop-blur">
                {dayLabel(day, today, yesterday)}
              </h2>
              <div className="rounded-md border bg-card">
                {dayEvents.map((e) => (
                  <EventRow key={e.id} event={e} />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

function FilterChip({
  href,
  active,
  children,
}: {
  href: string;
  active: boolean;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      className={cn(
        "rounded-full border px-3 py-1 text-sm transition-colors",
        active
          ? "border-transparent bg-primary text-primary-foreground"
          : "text-muted-foreground hover:text-foreground",
      )}
    >
      {children}
    </Link>
  );
}
