// An AI finding's evidence list: the analyst's human statement per item
// (verbatim quote for findings persisted before statements existed), each
// attributed to its source by document file name where one is on file.
// Shared by the variance detail page and the entry page's AI card so both
// surfaces read the same case file.

export type FindingEvidenceItem = {
  source: string;
  documentId: string | null;
  field: string | null;
  quote: string;
  statement?: string;
};

export function evidenceAttribution(
  e: FindingEvidenceItem,
  fileNameById: Map<string, string>,
): string {
  switch (e.source) {
    case "document":
      return e.documentId
        ? (fileNameById.get(e.documentId) ?? "Document on file")
        : "Document on file";
    case "entry":
      return "Entry as filed";
    case "reference":
      return "Reference data";
    case "calculation":
      return "Duty calculator";
    default:
      return e.source;
  }
}

export function FindingEvidenceList({
  evidence,
  documents,
}: {
  evidence: FindingEvidenceItem[];
  documents: { id: string; fileName: string }[];
}) {
  if (evidence.length === 0) return null;
  const fileNameById = new Map(documents.map((d) => [d.id, d.fileName]));
  return (
    <div>
      <h4 className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
        Evidence
      </h4>
      <div className="flex flex-col gap-2.5">
        {evidence.map((e, i) => (
          <div key={i} className="flex gap-2.5">
            <div className="mt-1.5 size-1.5 shrink-0 rounded-full bg-border" />
            <div>
              <p className="text-sm leading-relaxed">{e.statement ?? e.quote}</p>
              <p className="text-xs text-muted-foreground">
                {evidenceAttribution(e, fileNameById)}
              </p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
