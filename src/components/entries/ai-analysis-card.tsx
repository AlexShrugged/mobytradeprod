"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ChevronDown,
  Info,
  Loader2,
  OctagonAlert,
  RotateCcw,
  Sparkles,
  TriangleAlert,
} from "lucide-react";
import { toast } from "sonner";

import { StatusBadge } from "@/components/status-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { FindingEvidenceList } from "@/components/variance/finding-evidence";
import type {
  AiFindingRow,
  EntryAnalysisState,
  EntryDocument,
} from "@/lib/db/queries/entries";
import { formatDate } from "@/lib/format";
import { cn } from "@/lib/utils";

const severityMeta = {
  error: { icon: OctagonAlert, tone: "text-red-600 dark:text-red-400" },
  warning: { icon: TriangleAlert, tone: "text-amber-600 dark:text-amber-400" },
  info: { icon: Info, tone: "text-blue-600 dark:text-blue-400" },
} as const;

// The entry's AI case file: latest run state, the Analyze/Re-analyze
// action, and every persisted finding (line-scoped novel ones link into
// the variance reconciliation flow; corroborations render as context under
// the rule findings they support). Entry-scoped findings have no variance
// page (the route redirects them here), so this card IS their review
// surface: each row expands to the full case file — explanation, evidence,
// suggested action — that the variance page would show. Decisions PATCH
// /api/findings — the same human-judgment contract as audit alerts.
export function AiAnalysisCard({
  entryId,
  findings,
  documents,
  analysis,
}: {
  entryId: string;
  findings: AiFindingRow[];
  /** The entry's flat document list, for evidence attribution by file name. */
  documents: EntryDocument[];
  analysis: EntryAnalysisState;
}) {
  const router = useRouter();
  const [analyzing, setAnalyzing] = React.useState(false);
  const [busyId, setBusyId] = React.useState<string | null>(null);
  const [showHandled, setShowHandled] = React.useState(false);
  const [expandedIds, setExpandedIds] = React.useState<ReadonlySet<string>>(
    () => new Set(),
  );

  const toggleExpanded = (id: string) =>
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const open = findings.filter((f) => f.status === "open");
  const handled = findings.filter((f) => f.status !== "open");
  const inFlight = analysis.running || analyzing;

  async function analyze() {
    setAnalyzing(true);
    try {
      const res = await fetch(`/api/entries/${entryId}/analyze`, {
        method: "POST",
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(body?.error ?? "Analysis failed.");
      }
      if (body?.outcome?.status === "failed") {
        toast.error(body.outcome.error ?? "Analysis failed.");
      } else {
        const n = body?.outcome?.findingsCount ?? 0;
        toast.success(
          n === 0
            ? "Analysis complete. Nothing found."
            : `Analysis complete. ${n} finding${n === 1 ? "" : "s"}.`,
        );
      }
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Analysis failed.");
    } finally {
      setAnalyzing(false);
    }
  }

  async function setStatus(
    finding: AiFindingRow,
    status: "open" | "resolved" | "dismissed",
  ) {
    setBusyId(finding.id);
    try {
      const res = await fetch(`/api/findings/${finding.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error ?? "Failed to update the finding.");
      }
      toast.success(
        status === "open"
          ? "Finding reopened."
          : status === "resolved"
            ? "Finding accepted."
            : "Finding dismissed.",
      );
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Update failed.");
    } finally {
      setBusyId(null);
    }
  }

  const renderFinding = (f: AiFindingRow) => {
    const meta = severityMeta[f.severity];
    const SeverityIcon = meta.icon;
    const isOpen = f.status === "open";
    const novel = f.relatedAlertKeys.length === 0;
    const expanded = expandedIds.has(f.id);
    const panelId = `ai-finding-${f.id}`;
    return (
      <div
        key={f.id}
        className={cn("rounded-md border", !isOpen && "opacity-60")}
      >
        <div className="flex items-start gap-3 p-3">
          <SeverityIcon className={cn("mt-0.5 size-4 shrink-0", meta.tone)} />
          <div
            className="min-w-0 flex-1 cursor-pointer"
            onClick={() => {
              // Selecting text in the explanation shouldn't toggle the row.
              if (window.getSelection()?.toString()) return;
              toggleExpanded(f.id);
            }}
          >
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium">{f.title}</span>
              {f.lineNumber !== null ? (
                <Badge variant="outline" className="font-normal">
                  line {f.lineNumber}
                </Badge>
              ) : null}
              <StatusBadge status={f.alertType} />
              <span className="text-xs text-muted-foreground tabular-nums">
                {Math.round(f.confidence * 100)}%
              </span>
              {!novel ? (
                <span className="text-xs text-muted-foreground">
                  corroborates a rule finding
                </span>
              ) : null}
              {!isOpen ? (
                <Badge variant="secondary" className="font-normal">
                  {f.status === "resolved" ? "accepted" : f.status}
                </Badge>
              ) : null}
            </div>
            <p
              className={cn(
                "mt-1 text-sm text-muted-foreground",
                expanded
                  ? "whitespace-pre-line leading-relaxed"
                  : "line-clamp-3",
              )}
            >
              {f.explanation}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {f.lineItemId && novel ? (
              <Button variant="outline" size="sm" asChild>
                <Link
                  href={`/variance/${f.id}?from=entry`}
                  title="Open the full finding with its evidence"
                >
                  Review
                </Link>
              </Button>
            ) : isOpen ? (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busyId === f.id}
                  onClick={() => setStatus(f, "resolved")}
                >
                  Accept
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busyId === f.id}
                  onClick={() => setStatus(f, "dismissed")}
                >
                  Dismiss
                </Button>
              </>
            ) : (
              <Button
                variant="ghost"
                size="sm"
                disabled={busyId === f.id}
                onClick={() => setStatus(f, "open")}
              >
                <RotateCcw /> Reopen
              </Button>
            )}
            <Button
              variant="ghost"
              size="icon-sm"
              className="text-muted-foreground"
              aria-expanded={expanded}
              aria-controls={panelId}
              aria-label={expanded ? "Collapse finding" : "Expand finding"}
              onClick={() => toggleExpanded(f.id)}
            >
              <ChevronDown
                className={cn(
                  "transition-transform",
                  expanded && "rotate-180",
                )}
              />
            </Button>
          </div>
        </div>
        {expanded ? (
          <div
            id={panelId}
            className="flex flex-col gap-4 border-t px-3 py-3 pl-10"
          >
            {f.fields.length > 0 ? (
              <div>
                <h4 className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                  Fields
                </h4>
                <div className="overflow-x-auto">
                  <table className="text-sm">
                    <thead>
                      <tr className="text-left text-xs text-muted-foreground">
                        <th className="pb-1 pr-4 font-medium">Field</th>
                        <th className="pb-1 pr-4 font-medium">Filed</th>
                        <th className="pb-1 font-medium">Expected</th>
                      </tr>
                    </thead>
                    <tbody>
                      {f.fields.map((row, i) => (
                        <tr key={i} className="align-top">
                          <td className="py-0.5 pr-4 font-medium">
                            {row.field}
                          </td>
                          <td className="py-0.5 pr-4 tabular-nums">
                            {row.filed ?? "—"}
                          </td>
                          <td className="py-0.5 tabular-nums">
                            {row.expected ?? "—"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ) : null}
            <FindingEvidenceList evidence={f.evidence} documents={documents} />
            <div>
              <h4 className="mb-1.5 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                Suggested action
              </h4>
              <p className="whitespace-pre-line text-sm leading-relaxed">
                {f.suggestedAction}
              </p>
            </div>
            {f.resolutionNote ? (
              <p className="text-sm text-muted-foreground">
                Note: {f.resolutionNote}
              </p>
            ) : null}
          </div>
        ) : null}
      </div>
    );
  };

  const { latestRun } = analysis;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Sparkles className="size-4" /> AI analysis
        </CardTitle>
        <CardDescription>
          {inFlight
            ? "Analysis in progress. This takes a few minutes."
            : analysis.queued
              ? "Re-analysis queued after a tariff change."
              : latestRun === null
                ? "Not analyzed yet."
                : latestRun.status === "failed"
                  ? `Last run failed: ${latestRun.error ?? "unknown error"}`
                  : latestRun.finishedAt
                    ? `Analyzed ${formatDate(
                        latestRun.finishedAt.toISOString().slice(0, 10),
                      )}`
                    : "Analyzed"}
        </CardDescription>
        <CardAction>
          <Button
            size="sm"
            variant={latestRun === null ? "default" : "outline"}
            disabled={inFlight}
            onClick={() => void analyze()}
            title="Investigate this entry with the AI analyst"
          >
            {inFlight ? (
              <>
                <Loader2 className="animate-spin" /> Analyzing
              </>
            ) : latestRun === null ? (
              "Analyze"
            ) : (
              "Re-analyze"
            )}
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {latestRun?.status === "succeeded" && latestRun.summary ? (
          <p className="whitespace-pre-line text-sm text-muted-foreground">
            {latestRun.summary}
          </p>
        ) : null}
        {findings.length === 0 && latestRun?.status === "succeeded" ? (
          <p className="text-sm text-muted-foreground">
            No findings. The analyst reports this entry clean.
          </p>
        ) : null}
        {open.length > 0 ? (
          <div className="flex flex-col gap-2">{open.map(renderFinding)}</div>
        ) : null}
        {handled.length > 0 ? (
          <>
            <Button
              variant="ghost"
              size="sm"
              className="w-fit text-muted-foreground"
              onClick={() => setShowHandled((v) => !v)}
            >
              {showHandled ? "Hide" : "Show"} {handled.length} handled
            </Button>
            {showHandled ? (
              <div className="flex flex-col gap-2">
                {handled.map(renderFinding)}
              </div>
            ) : null}
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}
