"use client";

import * as React from "react";
import { Search } from "lucide-react";

import { FilterChip } from "@/components/variance/filter-chip";
import { VarianceTable } from "@/components/variance/variance-table";
import { Input } from "@/components/ui/input";
import type { VarianceQueueRow } from "@/lib/db/queries/variance";

export type VarianceTypeFilters = Record<
  string,
  { label: string; types: string[] }
>;

// Client shell for the Variance queue: search box on the left, the type
// filter chips to its right, then the table. The active type lives in the
// URL (?type=) so filtered views stay linkable; search is client state
// that narrows the table AND the chip counts, same idiom as Parts.
export function VarianceView({
  rows,
  typeFilters,
  activeType,
}: {
  rows: VarianceQueueRow[];
  typeFilters: VarianceTypeFilters;
  activeType: string | null;
}) {
  const [query, setQuery] = React.useState("");

  const searched = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter(
      (r) =>
        (r.sku ?? "").toLowerCase().includes(q) ||
        (r.description ?? "").toLowerCase().includes(q) ||
        r.entryNumber.toLowerCase().includes(q) ||
        (r.declaredHts ?? "").includes(q) ||
        (r.catalogHts ?? "").includes(q),
    );
  }, [rows, query]);

  const active = activeType !== null ? typeFilters[activeType] : null;
  const visible = active
    ? searched.filter((r) => active.types.includes(r.alertType))
    : searched;
  // Pre-search count for the active view — picks the table's empty message
  // ("no matches" only when the search emptied it, not the type filter).
  const visibleTotal = active
    ? rows.filter((r) => active.types.includes(r.alertType)).length
    : rows.length;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative max-w-sm flex-1 basis-64">
          <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Filter by SKU, entry, or HTS code…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="pl-8"
          />
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <FilterChip href="/variance" active={active === null}>
            All · {searched.length}
          </FilterChip>
          {Object.entries(typeFilters).map(([key, f]) => {
            // Hide types with nothing open at all. A search that zeroes a
            // chip keeps it visible (· 0) so the row doesn't reshuffle
            // under the cursor while typing.
            if (!rows.some((r) => f.types.includes(r.alertType))) return null;
            const n = searched.filter((r) =>
              f.types.includes(r.alertType),
            ).length;
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
      </div>

      <VarianceTable rows={visible} totalCount={visibleTotal} />
    </div>
  );
}
