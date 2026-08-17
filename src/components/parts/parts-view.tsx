"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { ChevronDown, Download, Plus, Search, Upload } from "lucide-react";

import { UrlPaginationControls } from "@/components/pagination-controls";
import { HtsReviewBanner } from "@/components/parts/hts-review-banner";
import { HtsReviewDialog } from "@/components/parts/hts-review-dialog";
import { ImportPartsDialog } from "@/components/parts/import-parts-dialog";
import { NewSkuDialog } from "@/components/parts/new-sku-dialog";
import { PartsTable } from "@/components/parts/parts-table";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import type { HtsReviewQueueItem, PartRow } from "@/lib/db/queries/parts";
import { encodeSetParam } from "@/lib/filter-params";
import { DEFAULT_PER_PAGE, pageCountFor } from "@/lib/pagination";
import {
  PART_STATUS_OPTIONS,
  PART_USAGE_STATUSES,
  type PartUsageStatus,
} from "@/lib/parts/status";

// Client shell for the Parts page: search + Status filter + Import/Export +
// New SKU on top, the expandable table, pagination below, and the two
// dialogs (HTS review walker, New SKU / add-quote). Search, status, and
// pagination are URL params — the server assembles only the visible page.

// One applied-state key over both filters, so the effect can tell a real
// change from a redundant re-render.
const appliedKey = (q: string, s: Set<PartUsageStatus>) =>
  `${q} ${encodeSetParam(s, PART_USAGE_STATUSES) ?? ""}`;

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
  initialStatus = [...PART_USAGE_STATUSES],
  statusCounts = { active: 0, inactive: 0 },
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
  /** Seeds the Status dropdown — both checked when ?status= is absent. */
  initialStatus?: PartUsageStatus[];
  /** Option counts under the current search, status filter excluded. */
  statusCounts?: Record<PartUsageStatus, number>;
}) {
  const router = useRouter();
  const [query, setQuery] = React.useState(initialQuery);
  const [status, setStatus] = React.useState<Set<PartUsageStatus>>(
    () => new Set(initialStatus),
  );

  // Debounced URL sync: typing or toggling Status replaces ?q=/?status=
  // (dropping ?page and the ?sku deep-link param) and the server
  // re-filters. replace, not push — every keystroke must not become a
  // history entry; the delay also coalesces rapid checkbox toggles. The
  // ref keeps the mount value from firing a redundant navigation.
  const applied = React.useRef(
    appliedKey(initialQuery.trim(), new Set(initialStatus)),
  );
  React.useEffect(() => {
    const q = query.trim();
    const next = appliedKey(q, status);
    if (next === applied.current) return;
    const t = setTimeout(() => {
      applied.current = next;
      const params = new URLSearchParams();
      if (q) params.set("q", q);
      const statusParam = encodeSetParam(status, PART_USAGE_STATUSES);
      if (statusParam) params.set("status", statusParam);
      if (per !== DEFAULT_PER_PAGE) params.set("per", String(per));
      const qs = params.toString();
      router.replace(qs ? `/parts?${qs}` : "/parts");
    }, 300);
    return () => clearTimeout(t);
  }, [query, status, per, router]);
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

      <div className="flex flex-wrap items-center gap-3">
        <div className="relative max-w-sm flex-1 basis-64">
          <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Filter by SKU, name, vendor, or HTS code…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="border-border bg-field pl-8 dark:bg-field"
          />
        </div>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm">
              Status:{" "}
              {status.size === PART_STATUS_OPTIONS.length
                ? "All"
                : status.size === 0
                  ? "None"
                  : PART_STATUS_OPTIONS.find((o) => status.has(o.status))!
                      .label}
              <ChevronDown className="text-muted-foreground" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-56">
            {PART_STATUS_OPTIONS.map((o) => (
              <DropdownMenuCheckboxItem
                key={o.status}
                checked={status.has(o.status)}
                onCheckedChange={(v) =>
                  setStatus((prev) => {
                    const next = new Set(prev);
                    if (v) next.add(o.status);
                    else next.delete(o.status);
                    return next;
                  })
                }
                onSelect={(e) => e.preventDefault()}
                title={o.title}
              >
                {o.label}
                <span className="ml-auto pl-4 text-xs tabular-nums text-muted-foreground">
                  {statusCounts[o.status]}
                </span>
              </DropdownMenuCheckboxItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>

        <div className="ml-auto flex items-center gap-2">
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
