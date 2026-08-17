"use client";

import * as React from "react";
import { ChevronDown, Download, Search } from "lucide-react";

import { PaginationControls } from "@/components/pagination-controls";
import { VarianceTable } from "@/components/variance/variance-table";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import type { VarianceQueueRow } from "@/lib/db/queries/variance";
import { DEFAULT_PER_PAGE, pageCountFor } from "@/lib/pagination";
import { varianceCsv } from "@/lib/variance/export";
import type { VarianceGroup } from "@/lib/variance/grouping";
import { PHASE_OPTIONS, type EntryPhase } from "@/lib/variance/window";

export type VarianceTypeFilters = Record<
  string,
  { label: string; types: string[] }
>;

export type QueueGroup = VarianceGroup<VarianceQueueRow>;

// Client shell for the Variance queue: search box, then three dropdown
// filters. Type is a multi-select over the variance buckets (all checked
// by default). Status splits the queue by work state: Open = lines with at
// least one undecided issue (the default view), Resolved = lines where
// every correction has been decided. Phase splits it by entry lifecycle:
// Unsubmitted (within 15 days of the entry date — the summary is still
// editable without a PSC), Submitted (both checked by default), and
// Liquidated — a liquidated entry's window is history, so its lines are
// reference, not work. All filter state is client state (same idiom as
// Parts' search). One table row is one line item with all its issues
// stacked, so every filter matches a group when ANY member matches, and
// the option counts answer "how many rows will I see if I check this".

export function VarianceView({
  openGroups,
  resolvedGroups,
  typeFilters,
}: {
  /** Lines with at least one open issue, queue-ordered. */
  openGroups: QueueGroup[];
  /** Fully-decided lines — every issue accepted or dismissed. */
  resolvedGroups: QueueGroup[];
  typeFilters: VarianceTypeFilters;
}) {
  const [query, setQuery] = React.useState("");
  const [checkedTypes, setCheckedTypes] = React.useState<Set<string>>(
    () => new Set(Object.keys(typeFilters)),
  );
  const [showOpen, setShowOpen] = React.useState(true);
  const [showResolved, setShowResolved] = React.useState(false);
  const [checkedPhases, setCheckedPhases] = React.useState<Set<EntryPhase>>(
    () => new Set(["unsubmitted", "submitted"]),
  );
  // Client-side pagination: unlike Parts/Events, every filter here is
  // client state over the already-loaded queue, so paging only bounds what
  // renders. Clamping (not resetting) keeps the page stable when a filter
  // change shrinks the list.
  const [page, setPage] = React.useState(1);
  const [per, setPer] = React.useState<number>(DEFAULT_PER_PAGE);

  const inTypes = (types: string[]) => (g: QueueGroup) =>
    g.members.some((r) => types.includes(r.alertType));

  // Buckets with nothing anywhere in the queue never appear as options —
  // the list stays stable while toggling the other filters.
  const typeOptions = React.useMemo(() => {
    const all = [...openGroups, ...resolvedGroups];
    return Object.entries(typeFilters).filter(([, f]) =>
      all.some(inTypes(f.types)),
    );
  }, [openGroups, resolvedGroups, typeFilters]);
  const allTypesChecked = typeOptions.every(([key]) =>
    checkedTypes.has(key),
  );
  const checkedCount = typeOptions.filter(([key]) =>
    checkedTypes.has(key),
  ).length;
  const checkedAlertTypes = React.useMemo(
    () =>
      new Set(
        typeOptions
          .filter(([key]) => checkedTypes.has(key))
          .flatMap(([, f]) => f.types),
      ),
    [typeOptions, checkedTypes],
  );

  // Each predicate is one filter; counts apply every predicate EXCEPT the
  // one whose options are being counted, so a count reads as "check this
  // and you'll see N rows".
  const q = query.trim().toLowerCase();
  const matchesQuery = (g: QueueGroup) =>
    q === "" ||
    g.members.some(
      (r) =>
        (r.sku ?? "").toLowerCase().includes(q) ||
        (r.description ?? "").toLowerCase().includes(q) ||
        r.entryNumber.toLowerCase().includes(q) ||
        (r.declaredHts ?? "").includes(q) ||
        (r.catalogHts ?? "").includes(q),
    );
  // Group members share one entry, so the first member speaks for the line.
  const phaseOf = (g: QueueGroup) => g.members[0].window.phase;
  const phaseOk = (g: QueueGroup) => checkedPhases.has(phaseOf(g));
  const typeOk = (g: QueueGroup) =>
    allTypesChecked || g.members.some((r) => checkedAlertTypes.has(r.alertType));

  // Open lines first, resolved history below — same order the two lists
  // arrive in.
  const statusBase = React.useMemo(
    () => [
      ...(showOpen ? openGroups : []),
      ...(showResolved ? resolvedGroups : []),
    ],
    [showOpen, showResolved, openGroups, resolvedGroups],
  );
  const visible = statusBase.filter(
    (g) => phaseOk(g) && typeOk(g) && matchesQuery(g),
  );
  const safePage = Math.min(page, pageCountFor(visible.length, per));
  // Pre-search count for the active view — picks the table's empty message
  // ("no matches" only when the search emptied it, not the other filters).
  const visibleTotal = statusBase.filter(
    (g) => phaseOk(g) && typeOk(g),
  ).length;

  const typeCount = (types: string[]) =>
    statusBase.filter(
      (g) => phaseOk(g) && matchesQuery(g) && inTypes(types)(g),
    ).length;
  const statusCount = (set: QueueGroup[]) =>
    set.filter((g) => phaseOk(g) && matchesQuery(g) && typeOk(g)).length;
  const phaseCount = (phase: EntryPhase) =>
    statusBase.filter(
      (g) => phaseOf(g) === phase && matchesQuery(g) && typeOk(g),
    ).length;

  const keepOpen = (e: Event) => e.preventDefault();

  // The broker correction file: exactly the rows on screen (every filter
  // applied), flattened to one CSV row per finding in display order. BOM so
  // Excel reads the UTF-8 diff text (—, →) correctly.
  const exportCsv = () => {
    const csv = varianceCsv(visible.flatMap((g) => g.members));
    const blob = new Blob(["\uFEFF" + csv], {
      type: "text/csv;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `variance-corrections-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };
  const optionCount = (n: number) => (
    <span className="ml-auto pl-4 text-xs tabular-nums text-muted-foreground">
      {n}
    </span>
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative max-w-sm flex-1 basis-64">
          <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Filter by SKU, entry, or HTS code…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="border-border bg-field pl-8 dark:bg-field"
          />
        </div>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm">
              Type:{" "}
              {allTypesChecked
                ? "All"
                : checkedCount === 0
                  ? "None"
                  : `${checkedCount} of ${typeOptions.length}`}
              <ChevronDown className="text-muted-foreground" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-56">
            <DropdownMenuCheckboxItem
              checked={allTypesChecked}
              onCheckedChange={(v) =>
                setCheckedTypes(
                  v ? new Set(Object.keys(typeFilters)) : new Set(),
                )
              }
              onSelect={keepOpen}
            >
              All
            </DropdownMenuCheckboxItem>
            <DropdownMenuSeparator />
            {typeOptions.map(([key, f]) => (
              <DropdownMenuCheckboxItem
                key={key}
                checked={checkedTypes.has(key)}
                onCheckedChange={(v) =>
                  setCheckedTypes((prev) => {
                    const next = new Set(prev);
                    if (v) next.add(key);
                    else next.delete(key);
                    return next;
                  })
                }
                onSelect={keepOpen}
              >
                {f.label}
                {optionCount(typeCount(f.types))}
              </DropdownMenuCheckboxItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm">
              Status:{" "}
              {showOpen && showResolved
                ? "All"
                : showOpen
                  ? "Open"
                  : showResolved
                    ? "Resolved"
                    : "None"}
              <ChevronDown className="text-muted-foreground" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-56">
            <DropdownMenuCheckboxItem
              checked={showOpen}
              onCheckedChange={(v) => setShowOpen(v === true)}
              onSelect={keepOpen}
            >
              Open
              {optionCount(statusCount(openGroups))}
            </DropdownMenuCheckboxItem>
            <DropdownMenuCheckboxItem
              checked={showResolved}
              onCheckedChange={(v) => setShowResolved(v === true)}
              onSelect={keepOpen}
              title="Lines where every correction has been made"
            >
              Resolved
              {optionCount(statusCount(resolvedGroups))}
            </DropdownMenuCheckboxItem>
          </DropdownMenuContent>
        </DropdownMenu>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm">
              Phase:{" "}
              {checkedPhases.size === PHASE_OPTIONS.length
                ? "All"
                : checkedPhases.size === 0
                  ? "None"
                  : checkedPhases.size === 1
                    ? PHASE_OPTIONS.find((o) => checkedPhases.has(o.phase))!
                        .label
                    : `${checkedPhases.size} of ${PHASE_OPTIONS.length}`}
              <ChevronDown className="text-muted-foreground" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-56">
            {PHASE_OPTIONS.map((o) => (
              <DropdownMenuCheckboxItem
                key={o.phase}
                checked={checkedPhases.has(o.phase)}
                onCheckedChange={(v) =>
                  setCheckedPhases((prev) => {
                    const next = new Set(prev);
                    if (v) next.add(o.phase);
                    else next.delete(o.phase);
                    return next;
                  })
                }
                onSelect={keepOpen}
                title={o.title}
              >
                {o.label}
                {optionCount(phaseCount(o.phase))}
              </DropdownMenuCheckboxItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>

        <Button
          variant="outline"
          size="sm"
          className="ml-auto"
          onClick={exportCsv}
          disabled={visible.length === 0}
          title="Download the filtered findings as a CSV for your broker"
        >
          <Download /> Export
        </Button>
      </div>

      <VarianceTable
        groups={visible.slice((safePage - 1) * per, safePage * per)}
        totalCount={visibleTotal}
      />

      <PaginationControls
        page={safePage}
        pageCount={pageCountFor(visible.length, per)}
        per={per}
        onPageChange={setPage}
        onPerChange={(p) => {
          setPer(p);
          setPage(1);
        }}
      />
    </div>
  );
}
