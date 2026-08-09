"use client";

// One staged base-schedule release: diffstat, sanity verdict, spot-check
// samples, and Approve & apply / Reject. The samples are display-only — the
// apply re-derives the full diff from the archived USITC payload inside the
// approval transaction, so what applies is always current truth, not a
// stale snapshot. A tripped sanity guard blocks apply unless the reviewer
// explicitly overrides it.

import * as React from "react";
import { useRouter } from "next/navigation";
import { Check, TriangleAlert, X } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { OpenBaseRelease } from "@/lib/db/queries/tariffs";
import { formatRate } from "@/lib/format";

export function BaseReleaseReviewCard({ release }: { release: OpenBaseRelease }) {
  const router = useRouter();
  const p = release.proposal;
  const [busy, setBusy] = React.useState(false);
  const [effectiveDate, setEffectiveDate] = React.useState(p.effectiveDate);
  const [force, setForce] = React.useState(false);

  async function decide(payload: Record<string, unknown>, pending: string) {
    setBusy(true);
    const toastId = toast.loading(pending);
    try {
      const res = await fetch(
        `/api/tariff-sync/base-releases/${release.announcementId}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        },
      );
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.error ?? "Update failed.");
      if (body?.action === "applied") {
        const audit = body.audit;
        toast.success(
          `Base schedule ${p.releaseName} applied: ${body.added} added, ${body.changed} changed, ${body.removed} removed` +
            (audit
              ? ` · ${audit.entries} entr${audit.entries === 1 ? "y" : "ies"} re-audited (${audit.created} new finding(s), ${audit.cleared} cleared)`
              : ""),
          { id: toastId, duration: 8000 },
        );
      } else {
        toast.success("Base release rejected.", { id: toastId });
      }
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Update failed.", {
        id: toastId,
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0">
        <CardTitle className="flex flex-wrap items-center gap-2 text-sm font-medium">
          <Badge variant="outline">Base schedule</Badge>
          <span>{p.releaseName}</span>
          <span className="font-normal text-muted-foreground">
            {p.added.toLocaleString()} added · {p.changed.toLocaleString()}{" "}
            changed · {p.removed.toLocaleString()} removed ·{" "}
            {p.unchanged.toLocaleString()} unchanged
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {p.sanity.ok ? null : (
          <div className="rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-sm">
            <div className="flex items-center gap-2 font-medium text-amber-700 dark:text-amber-400">
              <TriangleAlert className="size-4" /> Sanity guard tripped
            </div>
            <ul className="mt-1 list-disc pl-5 text-muted-foreground">
              {p.sanity.reasons.map((r, i) => (
                <li key={i}>{r}</li>
              ))}
            </ul>
          </div>
        )}

        {p.seedCorrections > 0 ? (
          <p className="text-sm text-muted-foreground">
            {p.seedCorrections} seeded demo rate
            {p.seedCorrections === 1 ? "" : "s"} will be corrected in place with
            certified values (no historical window minted — the seed rates were
            approximations).
          </p>
        ) : null}

        <SampleTables proposal={p} />

        <div className="flex flex-wrap items-end gap-4">
          <div className="space-y-1">
            <Label className="text-xs">Windows effective</Label>
            <Input
              type="date"
              value={effectiveDate}
              disabled={busy}
              onChange={(e) => setEffectiveDate(e.target.value)}
              className="w-44"
            />
          </div>
          {p.sanity.ok ? null : (
            <label className="flex items-center gap-2 pb-2 text-sm">
              <Checkbox
                checked={force}
                onCheckedChange={(v) => setForce(v === true)}
                disabled={busy}
              />
              Override the sanity guard
            </label>
          )}
        </div>

        <div className="flex gap-2">
          <Button
            size="sm"
            disabled={busy || !effectiveDate || (!p.sanity.ok && !force)}
            onClick={() =>
              void decide(
                { action: "approve", effectiveDate, force },
                "Applying base windows and re-auditing…",
              )
            }
          >
            <Check /> Approve
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => void decide({ action: "reject" }, "Rejecting…")}
          >
            <X /> Reject
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function SampleTables({
  proposal: p,
}: {
  proposal: OpenBaseRelease["proposal"];
}) {
  const sections: {
    label: string;
    rows: { code: string; description: string; detail: string }[];
    total: number;
  }[] = [
    {
      label: "Added",
      total: p.added,
      rows: p.sampleAdded.map((r) => ({
        code: r.code,
        description: r.description,
        detail: r.rate === null ? "—" : formatRate(r.rate),
      })),
    },
    {
      label: "Changed",
      total: p.changed,
      rows: p.sampleChanged.map((r) => ({
        code: r.code,
        description: r.description,
        detail: `${r.rateBefore === null ? "—" : formatRate(r.rateBefore)} → ${
          r.rateAfter === null ? "—" : formatRate(r.rateAfter)
        }`,
      })),
    },
    {
      label: "Removed",
      total: p.removed,
      rows: p.sampleRemoved.map((r) => ({
        code: r.code,
        description: r.description,
        detail: "window closes",
      })),
    },
  ];

  return (
    <div className="space-y-3">
      {sections
        .filter((s) => s.rows.length > 0)
        .map((s) => (
          <div key={s.label}>
            <div className="mb-1 text-xs font-medium text-muted-foreground">
              {s.label}
              {s.total > s.rows.length
                ? ` (first ${s.rows.length} of ${s.total.toLocaleString()})`
                : ""}
            </div>
            <div className="overflow-x-auto rounded-md border">
              <table className="w-full text-xs">
                <tbody>
                  {s.rows.map((r) => (
                    <tr key={`${s.label}-${r.code}`} className="border-b last:border-0">
                      <td className="whitespace-nowrap px-2 py-1 font-mono">
                        {r.code}
                      </td>
                      <td className="max-w-md truncate px-2 py-1 text-muted-foreground">
                        {r.description}
                      </td>
                      <td className="whitespace-nowrap px-2 py-1 text-right font-mono">
                        {r.detail}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ))}
    </div>
  );
}
