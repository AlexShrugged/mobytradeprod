"use client";

import * as React from "react";
import { Plus, Search } from "lucide-react";

import { HtsReviewBanner } from "@/components/parts/hts-review-banner";
import { HtsReviewDialog } from "@/components/parts/hts-review-dialog";
import { NewSkuDialog } from "@/components/parts/new-sku-dialog";
import { PartsTable } from "@/components/parts/parts-table";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { HtsReviewQueueItem, PartRow } from "@/lib/db/queries/parts";

// Client shell for the Parts page: search + New SKU on top, the expandable
// table, and the two dialogs (HTS review walker, New SKU / add-quote).

type SkuDialogState =
  // "New SKU" — both tabs, SKU editable.
  | { presetSku: null }
  // Per-part "Add quote" — quote tab only, SKU fixed.
  | { presetSku: string };

export function PartsView({
  parts,
  queue,
  initialReviewPartId,
  initialExpandedPartId,
}: {
  parts: PartRow[];
  queue: HtsReviewQueueItem[];
  initialReviewPartId: string | null;
  initialExpandedPartId: string | null;
}) {
  const [query, setQuery] = React.useState("");
  const [reviewIndex, setReviewIndex] = React.useState<number | null>(() => {
    if (initialReviewPartId === null) return null;
    const i = queue.findIndex((q) => q.part.id === initialReviewPartId);
    return i >= 0 ? i : null;
  });
  const [skuDialog, setSkuDialog] = React.useState<SkuDialogState | null>(null);

  const filtered = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return parts;
    return parts.filter(
      (p) =>
        p.sku.toLowerCase().includes(q) ||
        p.name.toLowerCase().includes(q) ||
        (p.htsCode ?? "").includes(q),
    );
  }, [parts, query]);

  return (
    <div className="flex flex-col gap-4">
      <HtsReviewBanner count={queue.length} onStart={() => setReviewIndex(0)} />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="relative max-w-sm flex-1 basis-64">
          <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Filter by SKU, name, or HTS code…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="pl-8"
          />
        </div>
        <Button size="sm" onClick={() => setSkuDialog({ presetSku: null })}>
          <Plus /> New SKU
        </Button>
      </div>

      <PartsTable
        parts={filtered}
        totalCount={parts.length}
        initialExpandedPartId={initialExpandedPartId}
        onReview={(partId) => {
          const i = queue.findIndex((q) => q.part.id === partId);
          if (i >= 0) setReviewIndex(i);
        }}
        onAddQuote={(part) => setSkuDialog({ presetSku: part.sku })}
      />

      <HtsReviewDialog
        queue={queue}
        openIndex={reviewIndex}
        onOpenChange={setReviewIndex}
      />
      {/* Keyed by preset so "Add quote" for another SKU remounts fresh. */}
      {skuDialog !== null ? (
        <NewSkuDialog
          key={skuDialog.presetSku ?? "new"}
          presetSku={skuDialog.presetSku}
          onClose={() => setSkuDialog(null)}
        />
      ) : null}
    </div>
  );
}
