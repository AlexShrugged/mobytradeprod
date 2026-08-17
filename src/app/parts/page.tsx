import { PageHeader } from "@/components/page-header";
import { PartsView } from "@/components/parts/parts-view";
import {
  getHtsReviewQueue,
  getPartPageIndex,
  getParts,
} from "@/lib/db/queries/parts";
import { parsePageParams } from "@/lib/pagination";

export const dynamic = "force-dynamic";

// ?review=<partId> deep-links from entry audit alerts straight into that
// part's HTS review; ?expand=<partId> deep-links from the events feed with
// that part's row pre-expanded; ?sku=<sku> seeds the catalog search (the
// variance page's "Source: Catalog" citations land here). There is no
// per-SKU page yet — the filtered catalog IS the SKU view. Search (?q=) and
// pagination (?page=, ?per=) are server-side: the catalog can be tens of
// thousands of SKUs, so only one page is ever assembled.
export default async function PartsPage({
  searchParams,
}: {
  searchParams: Promise<{
    review?: string;
    expand?: string;
    sku?: string;
    q?: string;
    page?: string;
    per?: string;
  }>;
}) {
  const params = await searchParams;
  const { review, expand, sku } = params;
  const q = (params.q ?? sku ?? "").trim() || null;
  const { page: requestedPage, per } = parsePageParams(params);

  // A deep-linked part must be on the page we open — resolve which one,
  // unless the URL already pins a page.
  const target = review ?? expand;
  const page =
    target && !params.page
      ? await getPartPageIndex(target, per, q)
      : requestedPage;

  const [{ rows, totalCount, filteredCount, page: effectivePage }, queue] =
    await Promise.all([getParts({ page, per, q }), getHtsReviewQueue()]);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Parts"
        info="Your SKU catalog: costs, origins, HTS classification, and quotes."
      />
      {/* Keyed by the sku deep-link param so a new deep link re-seeds the
          search box even when the client component is already mounted.
          (Typed searches write ?q= — a different param, so typing never
          remounts the view out from under the input.) */}
      <PartsView
        key={sku ?? ""}
        parts={rows}
        totalCount={totalCount}
        filteredCount={filteredCount}
        page={effectivePage}
        per={per}
        queue={queue}
        initialReviewPartId={review ?? null}
        initialExpandedPartId={expand ?? null}
        initialQuery={q ?? ""}
      />
    </div>
  );
}
