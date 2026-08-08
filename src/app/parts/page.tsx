import { PageHeader } from "@/components/page-header";
import { PartsView } from "@/components/parts/parts-view";
import { getHtsReviewQueue, getParts } from "@/lib/db/queries/parts";

export const dynamic = "force-dynamic";

// ?review=<partId> deep-links from entry audit alerts straight into that
// part's HTS review; ?expand=<partId> deep-links from the events feed with
// that part's row pre-expanded; ?sku=<sku> seeds the catalog filter (the
// variance page's "Source: Catalog" citations land here). There is no
// per-SKU page yet — the filtered catalog IS the SKU view.
export default async function PartsPage({
  searchParams,
}: {
  searchParams: Promise<{ review?: string; expand?: string; sku?: string }>;
}) {
  const [{ review, expand, sku }, parts, queue] = await Promise.all([
    searchParams,
    getParts(),
    getHtsReviewQueue(),
  ]);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Parts"
        info="Your SKU catalog: costs, origins, HTS classification, and quotes."
      />
      {/* Keyed by the sku filter so a new deep link re-seeds the search box
          even when the client component is already mounted. */}
      <PartsView
        key={sku ?? ""}
        parts={parts}
        queue={queue}
        initialReviewPartId={review ?? null}
        initialExpandedPartId={expand ?? null}
        initialQuery={sku ?? ""}
      />
    </div>
  );
}
