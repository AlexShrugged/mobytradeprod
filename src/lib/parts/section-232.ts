// The importer's per-SKU Section 232 designation, as catalog files carry it:
// one column whose header mentions 232 ("Section 232", "232", "Steel
// Hardware for Section 232") holding Yes/No. Pure: header detection, header
// polarity, cell reading, and the display vocabulary. No IO, no schema
// imports. Tests colocated.
//
// The stored fact is tri-state: true = Section 232 applies to the SKU,
// false = it does not, null = the importer has not said. A blank cell is
// never a "no" — real catalogs mark the few hundred SKUs that carry steel
// hardware and leave the other twenty thousand empty.

/** True when the header names Section 232: "232" as a number of its own,
 *  never digits inside a longer number ("Item 12320"). */
export function isSection232Header(header: string): boolean {
  return /(^|[^0-9])232([^0-9]|$)/.test(header);
}

// A header phrased as the exemption flips the column: under "Section 232
// Exempt", Yes means the SKU is exempt, so 232 does NOT apply.
const EXEMPT_HEADER = /exempt|exclu|not\s*subject|non\s*-?\s*subject/i;

export function isExemptionHeader(header: string): boolean {
  return EXEMPT_HEADER.test(header);
}

const normalizeCell = (cell: string): string =>
  cell
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

const YES = new Set(["yes", "y", "true", "t", "1", "x"]);
const NO = new Set(["no", "n", "false", "f", "0"]);

// Cells that state the answer in words decide it whatever the header's
// polarity: "Exempt" under "Section 232" and "Subject" under "232 Exempt"
// both say what they mean. Negatives are tested first ("not subject"
// contains "subject").
const SAYS_NOT_APPLIES =
  /\b(exempt|exempted|exemption|excluded|exclusion|not subject|non subject)\b/;
const SAYS_APPLIES = /\b(applies|applicable|subject|dutiable)\b/;
// "Not applicable" answers the header's own question, so it reads with the
// header: no 232 under "Section 232", nothing at all under "232 Exempt"
// (the exemption not applying does not say the tariff does).
const SAYS_NOTHING_APPLIES =
  /\b(not applicable|does not apply|doesn t apply|none)\b/;

export type Section232Cell =
  | { ok: true; value: boolean | null }
  | { ok: false; problem: string };

/** One cell of a Section 232 column → the stored designation. `header`
 *  decides polarity. Blank and "N/A" read as not specified. */
export function parseSection232Cell(
  header: string,
  cell: string | null,
): Section232Cell {
  if (cell === null) return { ok: true, value: null };
  const text = normalizeCell(cell);
  if (text === "" || text === "n a" || text === "na") {
    return { ok: true, value: null };
  }
  const exempt = isExemptionHeader(header);
  if (SAYS_NOT_APPLIES.test(text)) return { ok: true, value: false };
  if (SAYS_NOTHING_APPLIES.test(text)) {
    return { ok: true, value: exempt ? null : false };
  }
  if (SAYS_APPLIES.test(text)) return { ok: true, value: true };

  if (YES.has(text)) return { ok: true, value: !exempt };
  if (NO.has(text)) return { ok: true, value: exempt };
  return {
    ok: false,
    problem: `Section 232 value "${cell.trim()}" is not Yes or No`,
  };
}

// ------------------------------------------------------------- vocabulary

/** The value as a catalog file prints it — what the CSV export writes and
 *  field_changes record. Round-trips through parseSection232Cell under a
 *  plain "Section 232" header. */
export function section232ToCell(value: boolean | null): string | null {
  return value === null ? null : value ? "Yes" : "No";
}

/** The analyst-facing vocabulary: null stays null so "not specified" can
 *  never be mistaken for an answer. */
export type Section232Mark = "applies" | "does_not_apply";

export function section232Mark(value: boolean | null): Section232Mark | null {
  return value === null ? null : value ? "applies" : "does_not_apply";
}
