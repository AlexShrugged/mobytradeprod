"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { ChevronDown, Search } from "lucide-react";

import {
  EntriesTable,
  type EntriesTableRow,
} from "@/components/entries/entries-table";
import { UrlPaginationControls } from "@/components/pagination-controls";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import {
  AUDIT_OPTIONS,
  DEFAULT_ENTRY_SORT,
  ENTRY_AUDIT_STATES,
  SORT_OPTIONS,
  type EntryAuditState,
  type EntrySort,
} from "@/lib/entries/list-params";
import { encodeSetParam } from "@/lib/filter-params";
import { DEFAULT_PER_PAGE, pageCountFor } from "@/lib/pagination";
import {
  ENTRY_PHASES,
  PHASE_OPTIONS,
  type EntryPhase,
} from "@/lib/variance/window";

// Client shell for the Entries page: search + Phase and Audit dropdowns on
// top with the sort at the right edge, the expandable table, pagination
// below. Search (?q=), phase (?phase=), audit (?audit=) and sort (?sort=)
// are URL params like Parts' search — the server assembles only the
// visible page — with the same debounced replace (typing must not mint
// history entries; the delay also coalesces rapid checkbox toggles).

// One applied-state key over the search, both filters and the sort, so the
// effect can tell a real change from a redundant re-render.
const appliedKey = (
  q: string,
  p: Set<EntryPhase>,
  a: Set<EntryAuditState>,
  s: EntrySort,
) =>
  JSON.stringify([
    q,
    encodeSetParam(p, ENTRY_PHASES),
    encodeSetParam(a, ENTRY_AUDIT_STATES),
    s,
  ]);

const keepOpen = (e: Event) => e.preventDefault();

// One checkbox dropdown per set filter: the trigger names the selection,
// every option carries the rows it would show.
function SetFilterMenu<T extends string>({
  label,
  options,
  selected,
  counts,
  onChange,
}: {
  label: string;
  options: { value: T; label: string; title?: string }[];
  selected: Set<T>;
  counts: Record<T, number>;
  onChange: (update: (prev: Set<T>) => Set<T>) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm">
          {label}:{" "}
          {selected.size === options.length
            ? "All"
            : selected.size === 0
              ? "None"
              : selected.size === 1
                ? options.find((o) => selected.has(o.value))!.label
                : `${selected.size} of ${options.length}`}
          <ChevronDown className="text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56">
        {options.map((o) => (
          <DropdownMenuCheckboxItem
            key={o.value}
            checked={selected.has(o.value)}
            onCheckedChange={(v) =>
              onChange((prev) => {
                const next = new Set(prev);
                if (v) next.add(o.value);
                else next.delete(o.value);
                return next;
              })
            }
            onSelect={keepOpen}
            title={o.title}
          >
            {o.label}
            <span className="ml-auto pl-4 text-xs tabular-nums text-muted-foreground">
              {counts[o.value]}
            </span>
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const PHASE_MENU_OPTIONS = PHASE_OPTIONS.map((o) => ({
  value: o.phase,
  label: o.label,
  title: o.title,
}));
const AUDIT_MENU_OPTIONS = AUDIT_OPTIONS.map((o) => ({
  value: o.state,
  label: o.label,
  title: o.title,
}));

export function EntriesView({
  rows,
  totalCount,
  filteredCount,
  phaseCounts,
  auditCounts,
  page,
  per,
  initialQuery = "",
  initialPhases,
  initialAudit,
  initialSort,
}: {
  /** The visible page: future-entry projections (page 1) plus entries. */
  rows: EntriesTableRow[];
  /** Entries in the org, unfiltered — drives the empty state. */
  totalCount: number;
  /** Entries matching the filters — drives the page count. */
  filteredCount: number;
  /** Option counts under the search and the other filter, the option's
   *  own filter excluded. */
  phaseCounts: Record<EntryPhase, number>;
  auditCounts: Record<EntryAuditState, number>;
  page: number;
  per: number;
  initialQuery?: string;
  initialPhases: EntryPhase[];
  initialAudit: EntryAuditState[];
  initialSort: EntrySort;
}) {
  const router = useRouter();
  const [query, setQuery] = React.useState(initialQuery);
  const [phases, setPhases] = React.useState<Set<EntryPhase>>(
    () => new Set(initialPhases),
  );
  const [audit, setAudit] = React.useState<Set<EntryAuditState>>(
    () => new Set(initialAudit),
  );
  const [sort, setSort] = React.useState(initialSort);

  // The ref keeps the mount value from firing a redundant navigation
  // (same idiom as Parts).
  const applied = React.useRef(
    appliedKey(
      initialQuery.trim(),
      new Set(initialPhases),
      new Set(initialAudit),
      initialSort,
    ),
  );
  React.useEffect(() => {
    const q = query.trim();
    const next = appliedKey(q, phases, audit, sort);
    if (next === applied.current) return;
    const t = setTimeout(() => {
      applied.current = next;
      const params = new URLSearchParams();
      if (q) params.set("q", q);
      const phase = encodeSetParam(phases, ENTRY_PHASES);
      if (phase) params.set("phase", phase);
      const auditParam = encodeSetParam(audit, ENTRY_AUDIT_STATES);
      if (auditParam) params.set("audit", auditParam);
      if (sort !== DEFAULT_ENTRY_SORT) params.set("sort", sort);
      if (per !== DEFAULT_PER_PAGE) params.set("per", String(per));
      const qs = params.toString();
      router.replace(qs ? `/entries?${qs}` : "/entries");
    }, 300);
    return () => clearTimeout(t);
  }, [query, phases, audit, sort, per, router]);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative max-w-sm flex-1 basis-64">
          <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Filter by entry #, port, shipment, PO, or SKU…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="border-border bg-field pl-8 dark:bg-field"
          />
        </div>

        <SetFilterMenu
          label="Phase"
          options={PHASE_MENU_OPTIONS}
          selected={phases}
          counts={phaseCounts}
          onChange={setPhases}
        />
        <SetFilterMenu
          label="Audit"
          options={AUDIT_MENU_OPTIONS}
          selected={audit}
          counts={auditCounts}
          onChange={setAudit}
        />

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm" className="ml-auto">
              Sort by: {SORT_OPTIONS.find((o) => o.sort === sort)!.label}
              <ChevronDown className="text-muted-foreground" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-44">
            {SORT_OPTIONS.map((o) => (
              <DropdownMenuItem key={o.sort} onSelect={() => setSort(o.sort)}>
                {o.label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <EntriesTable rows={rows} totalCount={totalCount} />

      <UrlPaginationControls
        page={page}
        pageCount={pageCountFor(filteredCount, per)}
        per={per}
      />
    </div>
  );
}
