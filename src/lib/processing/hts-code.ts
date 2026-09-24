// Canonical form for an HTS/HS code as a document prints it.
//
// Suppliers and brokers print the same code many ways: "8708.91.9900" (the
// HTSUS form), "8708.91.99 00" (statistical suffix after a space — MotoRad's
// Mexican supplier), "3923.50.01.00" (four-dotted), "870891" (a 6-digit HS
// heading), "8708919900" (bare digits). They are all one code, and the
// comparisons downstream (invoice-vs-entry prefix match, catalog checks)
// run over the digits. Anything else — a list ("8481.80; 8708.91"), a
// letter prefix, extraction noise — is not a single code: it is kept as
// printed for the reader but yields no digits, so it compares as unknown
// (never a discrepancy) instead of failing the document on a column
// width. 27 MotoRad invoices and 5 ASC invoices failed on exactly that
// before this existed (2026-09-24).

/** Width of the extraction-fed hts_code columns; a printed value that is
 *  not a single code is capped here rather than rejected. */
export const HTS_CODE_MAX = 32;

const SINGLE_CODE = /^\d{4}(\.?\d{2}){1,3}$/;

/** "8708919900" → "8708.91.9900", "87089199" → "8708.91.99", "870891" → "8708.91". */
export function dottedHts(digits: string): string {
  const head = `${digits.slice(0, 4)}.${digits.slice(4, 6)}`;
  if (digits.length <= 6) return head;
  const sub = `${head}.${digits.slice(6, 8)}`;
  return digits.length <= 8 ? sub : `${sub}${digits.slice(8, 10)}`;
}

export type CanonicalHts = {
  /** The code to persist: canonical dotted form when the printed value is
   *  one code, else the printed text (trimmed, capped). Null only when the
   *  input is blank. */
  code: string | null;
  /** Comparison digits (6, 8 or 10), or null when the printed value is not a
   *  single code — unknown, never compared. */
  digits: string | null;
};

export function canonicalHts(
  printed: string | null | undefined,
): CanonicalHts {
  const trimmed = printed?.trim() ?? "";
  if (trimmed === "") return { code: null, digits: null };
  const compact = trimmed.replace(/\s+/g, "");
  if (SINGLE_CODE.test(compact)) {
    const digits = compact.replace(/\D/g, "");
    return { code: dottedHts(digits), digits };
  }
  return { code: trimmed.slice(0, HTS_CODE_MAX), digits: null };
}
