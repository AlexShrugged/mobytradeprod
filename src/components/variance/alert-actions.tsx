"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { RotateCcw } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";

// Decide the variance. The primary action stays "Resolve" (vague on purpose
// — per-type actions like PSC drafting come later); Dismiss closes it as
// not actionable. Same PATCH contract as the entry page's alert list; the
// auditor never touches resolved/dismissed rows, so the decision sticks.
export function AlertActions({
  alertId,
  status,
  alertType,
  partId,
}: {
  alertId: string;
  status: "open" | "resolved" | "dismissed";
  alertType: string;
  partId: string | null;
}) {
  const router = useRouter();
  const [busy, setBusy] = React.useState(false);

  async function setStatus(next: "open" | "resolved" | "dismissed") {
    setBusy(true);
    try {
      const res = await fetch(`/api/alerts/${alertId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: next }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error ?? "Failed to update the variance.");
      }
      toast.success(
        next === "open"
          ? "Variance reopened — the auditor owns it again."
          : next === "dismissed"
            ? "Variance dismissed."
            : "Variance resolved.",
      );
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Update failed.");
    } finally {
      setBusy(false);
    }
  }

  if (status !== "open") {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={() => setStatus("open")}
        >
          <RotateCcw /> Reopen
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button size="sm" disabled={busy} onClick={() => setStatus("resolved")}>
        Resolve
      </Button>
      <Button
        variant="outline"
        size="sm"
        disabled={busy}
        onClick={() => setStatus("dismissed")}
      >
        Dismiss
      </Button>
      {(alertType === "hts_discrepancy" || alertType === "hts_reclassified") &&
      partId ? (
        <Button variant="outline" size="sm" asChild>
          <Link
            href={`/parts?review=${partId}`}
            title="Open this part in the HTS review queue"
          >
            Reclassify part
          </Link>
        </Button>
      ) : null}
    </div>
  );
}
