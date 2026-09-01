"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Search } from "lucide-react";

import {
  DocumentsTable,
  type DocumentRow,
} from "@/components/data/documents-table";
import { UrlPaginationControls } from "@/components/pagination-controls";
import { Input } from "@/components/ui/input";
import { DEFAULT_PER_PAGE, pageCountFor } from "@/lib/pagination";

// Client shell for the Data page's documents list: search on top, the
// table, pagination below. Search and pagination are URL params — the
// server assembles only the visible page.
export function DocumentsView({
  documents,
  totalCount,
  filteredCount,
  page,
  per,
  initialQuery = "",
}: {
  documents: DocumentRow[];
  totalCount: number;
  filteredCount: number;
  page: number;
  per: number;
  initialQuery?: string;
}) {
  const router = useRouter();
  const [query, setQuery] = React.useState(initialQuery);

  // Debounced URL sync: typing replaces ?q= (dropping ?page) and the
  // server re-filters. replace, not push — every keystroke must not become
  // a history entry. The ref keeps the mount value from firing a redundant
  // navigation.
  const applied = React.useRef(initialQuery.trim());
  React.useEffect(() => {
    const q = query.trim();
    if (q === applied.current) return;
    const t = setTimeout(() => {
      applied.current = q;
      const params = new URLSearchParams();
      if (q) params.set("q", q);
      if (per !== DEFAULT_PER_PAGE) params.set("per", String(per));
      const qs = params.toString();
      router.replace(qs ? `/data?${qs}` : "/data");
    }, 300);
    return () => clearTimeout(t);
  }, [query, per, router]);

  return (
    <div className="flex flex-col gap-3">
      <div className="relative max-w-sm">
        <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          placeholder="Filter by file name or type…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="border-border bg-field pl-8 dark:bg-field"
        />
      </div>

      <DocumentsTable
        documents={documents}
        totalCount={totalCount}
        filteredCount={filteredCount}
        pageStart={(page - 1) * per}
      />

      <UrlPaginationControls
        page={page}
        pageCount={pageCountFor(filteredCount, per)}
        per={per}
      />
    </div>
  );
}
