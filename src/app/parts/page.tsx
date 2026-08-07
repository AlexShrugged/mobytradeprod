import { PageHeader } from "@/components/page-header";
import { PartsView } from "@/components/parts/parts-view";
import { getHtsReviewQueue, getParts } from "@/lib/db/queries/parts";

export const dynamic = "force-dynamic";

// ?review=<partId> deep-links from entry audit alerts straight into that
// part's HTS review; ?expand=<partId> deep-links from the events feed with
// that part's row pre-expanded.
export default async function PartsPage({
  searchParams,
}: {
  searchParams: Promise<{ review?: string; expand?: string }>;
}) {
  const [{ review, expand }, parts, queue] = await Promise.all([
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
      <PartsView
        parts={parts}
        queue={queue}
        initialReviewPartId={review ?? null}
        initialExpandedPartId={expand ?? null}
      />
    </div>
  );
}
