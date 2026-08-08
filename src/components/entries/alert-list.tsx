"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Info, OctagonAlert, RotateCcw, TriangleAlert } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { AlertRow } from "@/lib/db/queries/entries";
import { pairSiblingAlerts, unitIds } from "@/lib/variance/grouping";
import { cn } from "@/lib/utils";

const severityMeta = {
  error: {
    icon: OctagonAlert,
    tone: "text-red-600 dark:text-red-400",
    label: "High",
  },
  warning: {
    icon: TriangleAlert,
    tone: "text-amber-600 dark:text-amber-400",
    label: "Medium",
  },
  info: {
    icon: Info,
    tone: "text-blue-600 dark:text-blue-400",
    label: "Low",
  },
} as const;

export function AlertList({ alerts }: { alerts: AlertRow[] }) {
  const router = useRouter();
  const [busyId, setBusyId] = React.useState<string | null>(null);
  const [showResolved, setShowResolved] = React.useState(false);

  const open = alerts.filter((a) => a.status === "open");
  const resolved = alerts.filter((a) => a.status !== "open");

  async function setStatus(
    alert: AlertRow,
    status: "open" | "resolved" | "dismissed",
  ) {
    setBusyId(alert.id);
    try {
      // A rate mismatch and its duty-amount twin are one finding — decide
      // them together here too, or this surface could re-create the
      // accept-one-dismiss-the-other contradiction.
      const lineAlerts = alerts.filter(
        (a) => a.lineItemId !== null && a.lineItemId === alert.lineItemId,
      );
      const unit = pairSiblingAlerts(lineAlerts).find((u) =>
        unitIds(u).includes(alert.id),
      );
      const ids = unit ? unitIds(unit) : [alert.id];
      const results = await Promise.all(
        ids.map((id) =>
          fetch(`/api/alerts/${id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ status }),
          }),
        ),
      );
      const failed = results.find((r) => !r.ok);
      if (failed) {
        const body = await failed.json().catch(() => null);
        throw new Error(body?.error ?? "Failed to update the alert.");
      }
      toast.success(
        status === "open"
          ? "Alert reopened — the auditor owns it again."
          : status === "resolved"
            ? "Alert accepted."
            : "Alert dismissed.",
      );
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Update failed.");
    } finally {
      setBusyId(null);
    }
  }

  if (alerts.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No audit findings. The declared charges match our reference data.
      </p>
    );
  }

  const renderAlert = (alert: AlertRow) => {
    const meta = severityMeta[alert.severity];
    const Icon = meta.icon;
    const isOpen = alert.status === "open";
    return (
      <div
        key={alert.id}
        className={cn(
          "flex items-start gap-3 rounded-md border p-3",
          !isOpen && "opacity-60",
        )}
      >
        <Icon className={cn("mt-0.5 size-4 shrink-0", meta.tone)} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium">{alert.label}</span>
            {alert.lineNumber !== null ? (
              <Badge variant="outline" className="font-normal">
                line {alert.lineNumber}
              </Badge>
            ) : null}
            <span className={cn("text-xs", meta.tone)}>{meta.label}</span>
            {!isOpen ? (
              <Badge variant="secondary" className="font-normal">
                {alert.status === "resolved" ? "accepted" : alert.status}
              </Badge>
            ) : null}
          </div>
          <p className="mt-1 text-sm text-muted-foreground">{alert.message}</p>
        </div>
        <div className="flex shrink-0 gap-1">
          {isOpen ? (
            <>
              {alert.alertType === "hts_discrepancy" && alert.partId ? (
                <Button variant="outline" size="sm" asChild>
                  <Link
                    href={`/parts?review=${alert.partId}`}
                    title="Open this part in the HTS review queue"
                  >
                    Review part
                  </Link>
                </Button>
              ) : null}
              <Button
                variant="outline"
                size="sm"
                disabled={busyId === alert.id}
                onClick={() => setStatus(alert, "resolved")}
              >
                Accept
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={busyId === alert.id}
                onClick={() => setStatus(alert, "dismissed")}
              >
                Dismiss
              </Button>
            </>
          ) : (
            <Button
              variant="ghost"
              size="sm"
              disabled={busyId === alert.id}
              onClick={() => setStatus(alert, "open")}
            >
              <RotateCcw /> Reopen
            </Button>
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="flex flex-col gap-2">
      {open.map(renderAlert)}
      {resolved.length > 0 ? (
        <>
          <Button
            variant="ghost"
            size="sm"
            className="w-fit text-muted-foreground"
            onClick={() => setShowResolved((v) => !v)}
          >
            {showResolved ? "Hide" : "Show"} {resolved.length} handled
          </Button>
          {showResolved ? resolved.map(renderAlert) : null}
        </>
      ) : null}
    </div>
  );
}
