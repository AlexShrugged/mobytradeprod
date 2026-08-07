import { Download, ExternalLink, FileText } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { docTypeLabel, formatBytes } from "@/lib/format";

// One source document behind a domain record: file name, doc type, size,
// whether the document created the record or merely references it, and —
// when documentId is set — open-in-browser and download affordances
// (GET /api/documents/[id]/file, ?disposition=inline for viewing).
export function DocumentChip({
  fileName,
  docType,
  fileSize,
  created,
  documentId,
  createdLabel = "created this entry",
}: {
  fileName: string;
  docType: string;
  fileSize: number;
  created: boolean;
  documentId?: string;
  createdLabel?: string;
}) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-md border px-3 py-2">
      <div className="flex min-w-0 items-center gap-2">
        <FileText className="size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0">
          <span className="block truncate text-sm font-medium">{fileName}</span>
          <span className="text-xs text-muted-foreground">
            {docTypeLabel(docType)} · {formatBytes(fileSize)}
          </span>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Badge
          variant={created ? "secondary" : "outline"}
          className="font-normal"
        >
          {created ? createdLabel : "references it"}
        </Badge>
        {documentId ? (
          <>
            <a
              href={`/api/documents/${documentId}/file?disposition=inline`}
              target="_blank"
              rel="noopener"
              className="text-muted-foreground transition-colors hover:text-foreground"
              title={`Open ${fileName}`}
              aria-label={`Open ${fileName}`}
            >
              <ExternalLink className="size-4" />
            </a>
            <a
              href={`/api/documents/${documentId}/file`}
              className="text-muted-foreground transition-colors hover:text-foreground"
              title={`Download ${fileName}`}
              aria-label={`Download ${fileName}`}
            >
              <Download className="size-4" />
            </a>
          </>
        ) : null}
      </div>
    </div>
  );
}
