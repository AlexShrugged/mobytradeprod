"use client";

import * as React from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { ChevronLeft, ChevronRight } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { DEFAULT_PER_PAGE, PER_PAGE_OPTIONS } from "@/lib/pagination";

// Windowed page list: first + last + current ±1, with ellipses over the
// gaps (1 … 4 5 6 … 519). Adjacent gaps of exactly one page render the
// page itself instead of a dot.
function pageItems(page: number, count: number): (number | "ellipsis")[] {
  const wanted = [...new Set([1, page - 1, page, page + 1, count])]
    .filter((p) => p >= 1 && p <= count)
    .sort((a, b) => a - b);
  const items: (number | "ellipsis")[] = [];
  let prev = 0;
  for (const p of wanted) {
    if (p - prev === 2) items.push(prev + 1);
    else if (p - prev > 2) items.push("ellipsis");
    items.push(p);
    prev = p;
  }
  return items;
}

// One pagination row for every list page: page position on the left,
// prev/next flanking the numbered pages in the center (numbers only when
// the total is known), per-page select on the right. Controlled — the
// URL-driven wrapper below wires it to search params for RSC pages;
// Variance drives it from client filter state.
export function PaginationControls({
  page,
  /** Null when the total is unknown (Events) — prev/next drive off hasNext. */
  pageCount,
  hasNext,
  per,
  onPageChange,
  onPerChange,
}: {
  page: number;
  pageCount: number | null;
  hasNext?: boolean;
  per: number;
  onPageChange: (page: number) => void;
  onPerChange: (per: number) => void;
}) {
  const nextDisabled =
    pageCount !== null ? page >= pageCount : hasNext !== true;
  // A single default-sized page needs no controls.
  if (page <= 1 && nextDisabled && per === DEFAULT_PER_PAGE) return null;

  return (
    <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-3">
      <span className="justify-self-start text-xs text-muted-foreground tabular-nums">
        Page {page}
        {pageCount !== null ? ` of ${pageCount}` : ""}
      </span>
      <div className="flex items-center gap-1">
        <Button
          variant="outline"
          size="icon"
          className="size-8"
          disabled={page <= 1}
          onClick={() => onPageChange(page - 1)}
          aria-label="Previous page"
        >
          <ChevronLeft />
        </Button>
        {pageCount !== null &&
          pageCount > 1 &&
          pageItems(page, pageCount).map((item, i) =>
            item === "ellipsis" ? (
              <span
                key={`e-${i}`}
                className="w-8 text-center text-xs text-muted-foreground"
                aria-hidden
              >
                …
              </span>
            ) : (
              <Button
                key={item}
                variant={item === page ? "outline" : "ghost"}
                size="icon"
                className="size-8 tabular-nums"
                aria-current={item === page ? "page" : undefined}
                aria-label={`Page ${item}`}
                onClick={() => item !== page && onPageChange(item)}
              >
                {item}
              </Button>
            ),
          )}
        <Button
          variant="outline"
          size="icon"
          className="size-8"
          disabled={nextDisabled}
          onClick={() => onPageChange(page + 1)}
          aria-label="Next page"
        >
          <ChevronRight />
        </Button>
      </div>
      <div className="flex items-center justify-self-end gap-2">
        <Select
          value={String(per)}
          onValueChange={(v) => onPerChange(Number(v))}
        >
          <SelectTrigger size="sm" className="h-8 w-[9rem]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PER_PAGE_OPTIONS.map((n) => (
              <SelectItem key={n} value={String(n)}>
                {n} per page
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}

/** URL-driven flavor for RSC pages: page/per live in search params, so
 *  navigation re-renders the server component with the new window. A per
 *  change returns to page 1 — the old offset means nothing at a new size. */
export function UrlPaginationControls({
  page,
  pageCount,
  hasNext,
  per,
}: {
  page: number;
  pageCount: number | null;
  hasNext?: boolean;
  per: number;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const navigate = (next: { page: number; per: number }) => {
    const params = new URLSearchParams(searchParams);
    if (next.page > 1) params.set("page", String(next.page));
    else params.delete("page");
    if (next.per !== DEFAULT_PER_PAGE) params.set("per", String(next.per));
    else params.delete("per");
    const qs = params.toString();
    router.push(qs ? `${pathname}?${qs}` : pathname);
  };

  return (
    <PaginationControls
      page={page}
      pageCount={pageCount}
      hasNext={hasNext}
      per={per}
      onPageChange={(p) => navigate({ page: p, per })}
      onPerChange={(p) => navigate({ page: 1, per: p })}
    />
  );
}
