import { Download, FileText } from "lucide-react";

import type { EntryDocument } from "@/lib/db/queries/entries";
import { docTypeLabel } from "@/lib/format";

// Compact document list for side rails: the whole row opens the file
// in-browser; the only text is the file name and its document type. The
// created/references distinction lives in the tooltip, not a badge, and the
// download affordance appears on hover/focus.
export function DocumentRail({ documents }: { documents: EntryDocument[] }) {
  return (
    <div className="divide-y">
      {documents.map((doc) => (
        <div
          key={doc.id}
          className="group flex items-center gap-2.5 py-2.5 first:pt-0 last:pb-0"
        >
          <FileText className="size-4 shrink-0 text-muted-foreground" />
          <a
            href={`/api/documents/${doc.id}/file?disposition=inline`}
            target="_blank"
            rel="noopener"
            className="min-w-0 flex-1"
            title={`${doc.created ? "Created this record" : "References this record"} — open ${doc.fileName}`}
          >
            <span className="block truncate text-sm font-medium group-hover:underline">
              {doc.fileName}
            </span>
            <span className="text-xs text-muted-foreground">
              {docTypeLabel(doc.docType)}
            </span>
          </a>
          <a
            href={`/api/documents/${doc.id}/file`}
            className="text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
            title={`Download ${doc.fileName}`}
            aria-label={`Download ${doc.fileName}`}
          >
            <Download className="size-4" />
          </a>
        </div>
      ))}
    </div>
  );
}
