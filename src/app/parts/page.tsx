import { PageHeader } from "@/components/page-header";
import { PartsView } from "@/components/parts/parts-view";
import {
  countReconsiderItems,
  getHtsReviewQueue,
  getPartPageIndex,
  getParts,
  type PartsAttention,
} from "@/lib/db/queries/parts";
import { parseSetParam } from "@/lib/filter-params";
import { parsePageParams } from "@/lib/pagination";
import { PART_USAGE_STATUSES } from "@/lib/parts/status";

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
    status?: string;
    attention?: string;
    page?: string;
    per?: string;
  }>;
}) {
  const params = await searchParams;
  const { review, expand, sku } = params;
  const q = (params.q ?? sku ?? "").trim() || null;
  const status = parseSetParam(params.status, PART_USAGE_STATUSES);
  // ?attention=reconsider narrows to SKUs whose cheapest option moved.
  const attention: PartsAttention | null =
    params.attention === "reconsider" ? "reconsider" : null;
  const { page: requestedPage, per } = parsePageParams(params);

  // A deep-linked part must be on the page we open — resolve which one,
  // unless the URL already pins a page.
  const target = review ?? expand;
  const page =
    target && !params.page
      ? await getPartPageIndex(target, per, q, status, attention)
      : requestedPage;

  const [
    { rows, totalCount, filteredCount, page: effectivePage, statusCounts },
    queue,
    reconsiderCount,
  ] = await Promise.all([
    getParts({ page, per, q, status, attention }),
    getHtsReviewQueue(),
    countReconsiderItems(),
  ]);

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
        initialStatus={[...status]}
        statusCounts={statusCounts}
        initialAttention={attention}
        reconsiderCount={reconsiderCount}
      />
    </div>
  );
}
