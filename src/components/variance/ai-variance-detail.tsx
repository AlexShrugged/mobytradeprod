import Link from "next/link";
import { ArrowLeft } from "lucide-react";

import { DocumentRail } from "@/components/document-rail";
import { StatusBadge } from "@/components/status-badge";
import { AlertActions } from "@/components/variance/alert-actions";
import { VarianceNavCard } from "@/components/variance/variance-nav-card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import type { AiVarianceDetail } from "@/lib/db/queries/variance";
import { formatDate } from "@/lib/format";
import {
  nextOpenSiblingId,
  pairSiblingAlerts,
  unitIds,
  unitStatus,
} from "@/lib/variance/grouping";

// The reconciliation page's AI variant: same header, same navigator, same
// Accept/Dismiss flow as a rule variance, but the body is the analyst's
// case file (claim, evidence quotes, suggested action) instead of a
// field diff. Server component; the shared AlertActions client handles the
// decisions (its endpoint decides findings too).

const EVIDENCE_SOURCE_LABELS: Record<string, string> = {
  document: "Document",
  entry: "Entry",
  reference: "Reference",
  calculation: "Calculation",
};

export function AiVarianceDetailView({
  detail,
  fromEntry,
}: {
  detail: AiVarianceDetail;
  fromEntry: boolean;
}) {
  const { finding, entry, window, line, documents, siblings } = detail;

  // Same unit math as the rule page. AI findings never pair, but the line's
  // rule units keep their twins, so advance/undo counts stay correct on
  // mixed lines.
  const units = pairSiblingAlerts(siblings);
  const unitRows = units.map((u) => ({
    id: u.primary.id,
    ids: unitIds(u),
    status: unitStatus(u),
    decidedAt: Math.max(
      0,
      ...[u.primary, u.consequence]
        .filter((m) => m !== null)
        .map((m) => m.resolvedAt?.getTime() ?? 0),
    ),
  }));
  const nextOpenAlertId = nextOpenSiblingId(unitRows, finding.id);
  const undoPrevious = unitRows
    .filter((u) => u.status !== "open" && !u.ids.includes(finding.id))
    .reduce<{ ids: string[]; backTo: string; decidedAt: number } | null>(
      (best, u) =>
        best === null || u.decidedAt > best.decidedAt
          ? { ids: u.ids, backTo: u.id, decidedAt: u.decidedAt }
          : best,
      null,
    );

  const fileNameById = new Map(documents.map((d) => [d.id, d.fileName]));

  return (
    <div className="flex flex-col gap-4">
      <div>
        <Button variant="ghost" size="sm" asChild className="-ml-2 mb-2">
          <Link href={fromEntry ? `/entries/${entry.id}` : "/variance"}>
            <ArrowLeft />{" "}
            {fromEntry
              ? `Back to entry ${entry.entryNumber}`
              : "Back to variance"}
          </Link>
        </Button>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-xl font-semibold tracking-tight">
            {finding.title}
          </h1>
          <StatusBadge status={finding.alertType} />
          {finding.status !== "open" ? (
            <Badge variant="secondary" className="font-normal">
              {finding.status === "resolved" ? "accepted" : finding.status}
            </Badge>
          ) : null}
        </div>
        <p className="text-sm text-muted-foreground">
          <Link
            href={`/entries/${entry.id}`}
            className="tabular-nums hover:underline"
          >
            Entry {entry.entryNumber}
          </Link>
          {line ? ` · line ${line.lineNumber}` : ""}
          {line?.sku ? ` · ${line.sku}` : ""}
          {entry.entryDate ? ` · filed ${formatDate(entry.entryDate)}` : ""}
          {window.phase === "liquidated"
            ? " · liquidated"
            : window.phase === "unsubmitted" && window.nextPhaseDate
              ? ` · unsubmitted · editable without PSC until ${formatDate(window.nextPhaseDate)}`
              : window.nextPhaseDate
                ? ` · submitted · est. liquidation ${formatDate(window.nextPhaseDate)} · ${window.daysLeft}d left`
                : ""}
        </p>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="flex flex-col gap-4 lg:col-span-2">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">AI finding</CardTitle>
              <CardDescription>
                Confidence {Math.round(finding.confidence * 100)}%
                {detail.model ? ` · ${detail.model}` : ""}
                {detail.analyzedAt
                  ? ` · analyzed ${formatDate(
                      detail.analyzedAt.toISOString().slice(0, 10),
                    )}`
                  : ""}
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-5">
              <p className="whitespace-pre-line text-sm leading-relaxed">
                {finding.explanation}
              </p>

              {finding.evidence.length > 0 ? (
                <div>
                  <h4 className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                    Evidence
                  </h4>
                  <div className="flex flex-col gap-2">
                    {finding.evidence.map((e, i) => (
                      <div
                        key={i}
                        className="rounded-md border bg-muted/30 p-2.5"
                      >
                        <div className="text-xs text-muted-foreground">
                          {EVIDENCE_SOURCE_LABELS[e.source] ?? e.source}
                          {e.documentId
                            ? ` · ${fileNameById.get(e.documentId) ?? e.documentId}`
                            : ""}
                          {e.field ? ` · ${e.field}` : ""}
                        </div>
                        <div className="mt-1 break-all font-mono text-xs">
                          {e.quote}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}

              <div>
                <h4 className="mb-1.5 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                  Suggested action
                </h4>
                <p className="whitespace-pre-line text-sm leading-relaxed">
                  {finding.suggestedAction}
                </p>
              </div>

              {finding.resolutionNote ? (
                <p className="text-sm text-muted-foreground">
                  Note: {finding.resolutionNote}
                </p>
              ) : null}
            </CardContent>
          </Card>

          <AlertActions
            alertId={finding.id}
            status={finding.status}
            alertType={finding.alertType}
            partId={finding.partId}
            entryId={entry.id}
            fromEntry={fromEntry}
            decideIds={[finding.id]}
            nextOpenAlertId={nextOpenAlertId}
            undoPrevious={undoPrevious}
            lineUnits={unitRows.map((u) => ({ ids: u.ids, status: u.status }))}
          />
        </div>

        <div className="flex flex-col gap-4">
          <VarianceNavCard
            siblings={siblings}
            currentId={finding.id}
            fromEntry={fromEntry}
          />

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Documents on file</CardTitle>
            </CardHeader>
            <CardContent>
              {documents.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No documents linked to this entry yet.
                </p>
              ) : (
                <DocumentRail documents={documents} />
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
