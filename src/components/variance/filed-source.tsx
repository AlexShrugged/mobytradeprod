import { Eye } from "lucide-react";

import {
  citationPageHref,
  citationSourceLabel,
  type FactCitationRef,
} from "@/lib/documents/citations";

// The eye beside a Filed figure: opens the page of the broker's document
// the figure was read from, sliced out and highlighted, in the browser's
// own viewer. Rendered only when the fact carries a citation.
export function FiledSource({ citation }: { citation: FactCitationRef }) {
  const label = `View on the ${citationSourceLabel(citation.docType)}, page ${citation.page}`;
  return (
    <a
      href={citationPageHref(citation)}
      target="_blank"
      rel="noopener"
      title={label}
      aria-label={label}
      className="ml-auto inline-flex shrink-0 items-center self-center rounded-sm p-0.5 text-muted-foreground no-underline hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
    >
      <Eye className="size-4" aria-hidden="true" />
    </a>
  );
}
