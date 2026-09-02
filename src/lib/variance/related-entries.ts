// Which OTHER entries an AI finding talks about. Cross-entry findings
// (Chapter 99 treatment splitting across one shipment, two packet copies of
// a sibling 7501 disagreeing) cite sibling entries by number in their
// title, explanation, fields and evidence; the reconciliation page uses
// this to put that entry's documents beside the current entry's. Pure
// string work — the query layer resolves numbers to rows.

/** The 7501 entry-number print form: 3-7-1 digits with hyphens. Only the
 *  hyphenated form counts — a bare 11-digit run is as likely a bill of
 *  lading as an entry number. */
const ENTRY_NUMBER = /\b\d{3}-\d{7}-\d\b/g;

/** Digits only — the same normalization the linker matches entries by. */
export function normalizeEntryNumber(entryNumber: string): string {
  return entryNumber.replace(/\D/g, "");
}

/** Every entry number cited across `texts` other than the finding's own
 *  entry, normalized to digits, in first-seen order. */
export function extractRelatedEntryNumbers(
  texts: (string | null | undefined)[],
  ownEntryNumber: string,
): string[] {
  const own = normalizeEntryNumber(ownEntryNumber);
  const out = new Set<string>();
  for (const text of texts) {
    if (!text) continue;
    for (const match of text.match(ENTRY_NUMBER) ?? []) {
      const n = normalizeEntryNumber(match);
      if (n !== own) out.add(n);
    }
  }
  return [...out];
}

/** The free-text surfaces of a finding where an entry number can appear. */
export function findingTexts(finding: {
  title: string;
  explanation: string;
  suggestedAction: string;
  fields: { field: string; filed: string | null; expected: string | null }[];
  evidence: { quote: string; statement?: string | null }[];
}): string[] {
  return [
    finding.title,
    finding.explanation,
    finding.suggestedAction,
    ...finding.fields.flatMap((f) => [f.field, f.filed, f.expected]),
    ...finding.evidence.flatMap((e) => [e.quote, e.statement]),
  ].filter((t): t is string => typeof t === "string" && t.length > 0);
}
