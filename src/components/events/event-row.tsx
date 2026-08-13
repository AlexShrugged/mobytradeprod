"use client";

// One feed row: icon ring, title with entity links, amount/delta pills, and
// a click-to-expand provenance panel (source documents with download, or the
// user + timestamp for manual changes).

import * as React from "react";
import Link from "next/link";
import { ChevronDown, ChevronRight, UserRound } from "lucide-react";

import { DocumentChip } from "@/components/document-chip";
import { eventMeta } from "@/components/events/event-meta";
import { Money } from "@/components/money";
import { cn } from "@/lib/utils";
import type { BusinessEvent } from "@/lib/events/types";
import { formatDate, formatDateTime } from "@/lib/format";

function TitleWithLinks({ event }: { event: BusinessEvent }) {
  // Entity labels that appear verbatim in the title become links in place;
  // refs that don't appear render as trailing chips instead.
  const linkable = event.entityRefs.filter((r) => r.href);
  let title: React.ReactNode = event.title;
  for (const ref of linkable) {
    if (typeof title !== "string" || !title.includes(ref.label)) continue;
    const [before, after] = title.split(ref.label, 2) as [string, string];
    title = (
      <>
        {before}
        <Link
          href={ref.href!}
          className="font-medium underline-offset-2 hover:underline"
          onClick={(e) => e.stopPropagation()}
        >
          {ref.label}
        </Link>
        {after}
      </>
    );
    break; // one in-place link is enough; the rest stay plain text
  }
  return <span className="min-w-0 text-sm">{title}</span>;
}

export function EventRow({ event }: { event: BusinessEvent }) {
  const [expanded, setExpanded] = React.useState(false);
  const meta = eventMeta[event.type];
  const Icon = meta.icon;
  const recordedDay = event.recordedAt.slice(0, 10);
  const lateRecorded = recordedDay !== event.occurredOn;

  return (
    <div className="border-b last:border-b-0">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-muted/40"
      >
        <span
          className={cn(
            "flex size-7 shrink-0 items-center justify-center rounded-full",
            meta.ringClass,
          )}
          title={meta.label}
        >
          <Icon className="size-3.5" />
        </span>
        <div className="min-w-0 flex-1">
          <TitleWithLinks event={event} />
          {event.detail ? (
            <div className="truncate text-xs text-muted-foreground">
              {event.detail}
            </div>
          ) : null}
        </div>
        {event.delta ? (
          <span className="hidden shrink-0 rounded-md bg-muted px-2 py-0.5 text-xs tabular-nums text-muted-foreground sm:inline">
            {event.delta.from ?? "—"} → {event.delta.to ?? "—"}
          </span>
        ) : null}
        {event.amountCents != null ? (
          <Money
            cents={event.amountCents}
            tone={
              event.amountTone === "duty"
                ? "duty"
                : event.amountTone === "refund"
                  ? "refund"
                  : "default"
            }
            className="shrink-0 text-sm"
          />
        ) : null}
        <span
          className="shrink-0 text-xs text-muted-foreground tabular-nums"
          title={
            event.dateBasis === "estimated"
              ? "Estimated date"
              : event.dateBasis === "recorded"
                ? "No business date on record; showing when it was recorded"
                : undefined
          }
        >
          {event.dateBasis !== "exact" ? "~" : ""}
          {formatDate(event.occurredOn)}
        </span>
        {expanded ? (
          <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
        )}
      </button>

      {expanded ? (
        <div className="space-y-2 bg-muted/30 pb-3 pl-[52px] pr-3 pt-1">
          {event.provenance.kind === "documents" ? (
            <div className="flex max-w-xl flex-col gap-1.5">
              {event.provenance.documents.map((d) => (
                <DocumentChip
                  key={d.id}
                  fileName={d.fileName}
                  docType={d.docType}
                  fileSize={d.fileSize}
                  created={d.created}
                  createdLabel="created this record"
                  documentId={d.id}
                />
              ))}
            </div>
          ) : event.provenance.kind === "user" ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <UserRound className="size-4" />
              Changed by {event.provenance.actor ?? "unknown user"} ·{" "}
              {formatDateTime(event.provenance.at)}
            </div>
          ) : (
            <div className="text-sm text-muted-foreground">
              System-derived{event.provenance.note ? ` · ${event.provenance.note}` : ""}
            </div>
          )}
          {event.delta ? (
            <dl className="grid max-w-md grid-cols-[auto_1fr] gap-x-4 gap-y-0.5 text-sm">
              <dt className="text-muted-foreground">Field</dt>
              <dd>{event.delta.field.replace(/_/g, " ")}</dd>
              <dt className="text-muted-foreground">From</dt>
              <dd className="tabular-nums">{event.delta.from ?? "—"}</dd>
              <dt className="text-muted-foreground">To</dt>
              <dd className="tabular-nums">{event.delta.to ?? "—"}</dd>
            </dl>
          ) : null}
          {lateRecorded ? (
            <div className="text-xs text-muted-foreground">
              Recorded {formatDate(recordedDay)}; shown by occurrence date.
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
