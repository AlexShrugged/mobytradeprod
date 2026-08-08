"use client";

import * as React from "react";
import { Search } from "lucide-react";

import { FilterChip } from "@/components/variance/filter-chip";
import { VarianceTable } from "@/components/variance/variance-table";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import type { VarianceQueueRow } from "@/lib/db/queries/variance";
import type { VarianceGroup } from "@/lib/variance/grouping";

export type VarianceTypeFilters = Record<
  string,
  { label: string; types: string[] }
>;

export type QueueGroup = VarianceGroup<VarianceQueueRow>;

// Client shell for the Variance queue: search box on the left, the type
// filter chips to its right, then the table. One table row is one line item
// (all of its issues stacked), so search and the ?type= filter match a
// group when ANY member matches — the chip answers "how many rows will I
// see". The active type lives in the URL (?type=) so filtered views stay
// linkable; search is client state that narrows the table AND the chip
// counts, same idiom as Parts. "Show archived" (off by default, client
// state like search) appends fully-decided lines below the active ones;
// search, chips, and their counts then cover both sets.
export function VarianceView({
  groups,
  archivedGroups,
  typeFilters,
  activeType,
}: {
  groups: QueueGroup[];
  archivedGroups: QueueGroup[];
  typeFilters: VarianceTypeFilters;
  activeType: string | null;
}) {
  const [query, setQuery] = React.useState("");
  const [showArchived, setShowArchived] = React.useState(false);

  const base = React.useMemo(
    () => (showArchived ? [...groups, ...archivedGroups] : groups),
    [groups, archivedGroups, showArchived],
  );

  const searched = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return base;
    const matches = (r: VarianceQueueRow) =>
      (r.sku ?? "").toLowerCase().includes(q) ||
      (r.description ?? "").toLowerCase().includes(q) ||
      r.entryNumber.toLowerCase().includes(q) ||
      (r.declaredHts ?? "").includes(q) ||
      (r.catalogHts ?? "").includes(q);
    return base.filter((g) => g.members.some(matches));
  }, [base, query]);

  const active = activeType !== null ? typeFilters[activeType] : null;
  const inTypes = (types: string[]) => (g: QueueGroup) =>
    g.members.some((r) => types.includes(r.alertType));
  const visible = active ? searched.filter(inTypes(active.types)) : searched;
  // Pre-search count for the active view — picks the table's empty message
  // ("no matches" only when the search emptied it, not the type filter).
  const visibleTotal = active
    ? base.filter(inTypes(active.types)).length
    : base.length;

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
        <div className="flex flex-wrap items-center gap-1.5">
          <FilterChip href="/variance" active={active === null}>
            All · {searched.length}
          </FilterChip>
          {Object.entries(typeFilters).map(([key, f]) => {
            // Hide types with nothing in the current view at all. A search
            // that zeroes a chip keeps it visible (· 0) so the row doesn't
            // reshuffle under the cursor while typing.
            if (!base.some(inTypes(f.types))) return null;
            const n = searched.filter(inTypes(f.types)).length;
            return (
              <FilterChip
                key={key}
                href={`/variance?type=${key}`}
                active={activeType === key}
              >
                {f.label} · {n}
              </FilterChip>
            );
          })}
        </div>
        <label className="ml-auto flex cursor-pointer select-none items-center gap-2 text-sm text-muted-foreground">
          <Checkbox
            checked={showArchived}
            onCheckedChange={(v) => setShowArchived(v === true)}
          />
          Show archived
        </label>
      </div>

      <VarianceTable groups={visible} totalCount={visibleTotal} />
    </div>
  );
}
