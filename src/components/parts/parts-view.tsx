"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Download, Plus, Search, Upload } from "lucide-react";

import { UrlPaginationControls } from "@/components/pagination-controls";
import { HtsReviewBanner } from "@/components/parts/hts-review-banner";
import { HtsReviewDialog } from "@/components/parts/hts-review-dialog";
import { ImportPartsDialog } from "@/components/parts/import-parts-dialog";
import { NewSkuDialog } from "@/components/parts/new-sku-dialog";
import { PartsTable } from "@/components/parts/parts-table";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { HtsReviewQueueItem, PartRow } from "@/lib/db/queries/parts";
import { DEFAULT_PER_PAGE, pageCountFor } from "@/lib/pagination";

// Client shell for the Parts page: search + Import/Export + New SKU on top,
// the expandable table, pagination below, and the two dialogs (HTS review
// walker, New SKU / add-quote). Search and pagination are URL params — the
// server assembles only the visible page.

type SkuDialogState =
  // "New SKU" — both tabs, SKU editable.
  | { presetSku: null }
  // Per-part "Add quote" — quote tab only, SKU fixed.
  | { presetSku: string };

export function PartsView({
  parts,
  totalCount,
  filteredCount,
  page,
  per,
  queue,
  initialReviewPartId,
  initialExpandedPartId,
  initialQuery = "",
}: {
  parts: PartRow[];
  totalCount: number;
  filteredCount: number;
  page: number;
  per: number;
  queue: HtsReviewQueueItem[];
  initialReviewPartId: string | null;
  initialExpandedPartId: string | null;
  /** Seeds the search box — ?sku= deep links land pre-filtered. */
  initialQuery?: string;
}) {
  const router = useRouter();
  const [query, setQuery] = React.useState(initialQuery);

  // Debounced URL sync: typing replaces ?q= (dropping ?page and the ?sku
  // deep-link param) and the server re-filters. replace, not push — every
  // keystroke must not become a history entry. The ref keeps the mount
  // value from firing a redundant navigation.
  const appliedQuery = React.useRef(initialQuery.trim());
  React.useEffect(() => {
    const next = query.trim();
    if (next === appliedQuery.current) return;
    const t = setTimeout(() => {
      appliedQuery.current = next;
      const params = new URLSearchParams();
      if (next) params.set("q", next);
      if (per !== DEFAULT_PER_PAGE) params.set("per", String(per));
      const qs = params.toString();
      router.replace(qs ? `/parts?${qs}` : "/parts");
    }, 300);
    return () => clearTimeout(t);
  }, [query, per, router]);
  const [reviewIndex, setReviewIndex] = React.useState<number | null>(() => {
    if (initialReviewPartId === null) return null;
    const i = queue.findIndex((q) => q.part.id === initialReviewPartId);
    return i >= 0 ? i : null;
  });
  // Set when a suggestion card launched the review — the dialog opens with
  // that candidate selected instead of the classifier's top pick.
  const [reviewPreselect, setReviewPreselect] = React.useState<{
    partId: string;
    code: string;
  } | null>(null);
  const [skuDialog, setSkuDialog] = React.useState<SkuDialogState | null>(null);
  const [importOpen, setImportOpen] = React.useState(false);

  return (
    <div className="flex flex-col gap-4">
      <HtsReviewBanner count={queue.length} onStart={() => setReviewIndex(0)} />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="relative max-w-sm flex-1 basis-64">
          <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Filter by SKU, name, vendor, or HTS code…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="border-border bg-field pl-8 dark:bg-field"
          />
        </div>
        <div className="flex items-center gap-2">
          {/* One split control: left half imports, right half exports. */}
          <div className="flex">
            <Button
              variant="outline"
              size="sm"
              className="rounded-r-none"
              onClick={() => setImportOpen(true)}
            >
              <Upload /> Import
            </Button>
            <Button
              variant="outline"
              size="sm"
              // The anchor keeps the UA pointer cursor; real buttons don't.
              className="-ml-px cursor-default rounded-l-none"
              asChild
            >
              <a href="/api/parts/export" download>
                <Download /> Export
              </a>
            </Button>
          </div>
          <Button size="sm" onClick={() => setSkuDialog({ presetSku: null })}>
            <Plus /> New SKU
          </Button>
        </div>
      </div>

      <PartsTable
        parts={parts}
        totalCount={totalCount}
        filteredCount={filteredCount}
        pageStart={(page - 1) * per}
        initialExpandedPartId={initialExpandedPartId}
        onReview={(partId, code) => {
          const i = queue.findIndex((q) => q.part.id === partId);
          if (i >= 0) {
            setReviewPreselect(code ? { partId, code } : null);
            setReviewIndex(i);
          }
        }}
        onAddQuote={(part) => setSkuDialog({ presetSku: part.sku })}
        onImport={() => setImportOpen(true)}
      />

      <UrlPaginationControls
        page={page}
        pageCount={pageCountFor(filteredCount, per)}
        per={per}
      />

      <HtsReviewDialog
        queue={queue}
        openIndex={reviewIndex}
        onOpenChange={setReviewIndex}
        preselect={reviewPreselect}
      />
      {/* Keyed by preset so "Add quote" for another SKU remounts fresh. */}
      {skuDialog !== null ? (
        <NewSkuDialog
          key={skuDialog.presetSku ?? "new"}
          presetSku={skuDialog.presetSku}
          onClose={() => setSkuDialog(null)}
        />
      ) : null}
      {importOpen ? (
        <ImportPartsDialog onClose={() => setImportOpen(false)} />
      ) : null}
    </div>
  );
}
