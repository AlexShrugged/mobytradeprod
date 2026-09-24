// The Special Program Indicator a 7501 line claims (column 27's letter
// prefix — "S" for USMCA, "IL" for the Israel FTA, "A" for GSP, "KR" for
// KORUS) is what the audit's base-duty expectation turns on, and the
// extractor drops it about a third of the time: on MotoRad's book 139 of
// the 227 open alerts were "declared 0%; the official rate is X%" on lines
// whose 7501 prints the code plainly (102 Israeli, 35 Mexican; 2026-09-24).
// The parse text carries it in one of a few places, so read it there
// deterministically — the line-sku.ts / fee-summary.ts idiom — and fill the
// field the extractor left blank. Measured over every processed 7501 (282
// documents, 760 lines): 81 of the 95 codes the extractor did capture are
// re-read identically, none differ, and 160 blank lines gain a code.
//
// A line is a BLOCK of table cells from its line-number cell to the cell
// that prints its HTS number. Within the block the code prints as:
//   - a lone cell right before the HTS cell ("A", "KR", "IL" — both brokers);
//   - inline, just before the HTS in the same cell ("…,OTH S 8301.20.0060",
//     "IL 9032.10.0090");
//   - inside the line-number cell after the number ("001 S" — Sobel's
//     rowspan cell — or merged with neighbours: "002 O,IL IL 003",
//     "005 IL O,IL"), where "O,IL" / "E,IL" are ORIGIN and export markers,
//     never claims;
//   - a lone cell (or a marker cell, "O,IL IL") elsewhere in the block, in
//     Sobel's layout only — recognised by the origin marker, which proves
//     the country cell is accounted for. Country codes double as program
//     symbols (IL, KR, SG, CO, …), so a block scan without that proof would
//     read an origin cell as a claim.
// Candidates that disagree leave the line alone; a continuation copy of the
// line's HTS later in the document is never its block because blocks are
// walked in line order from a cursor. The retired NAFTA symbols CA/MX are
// deliberately not symbols here — "001 MX EO USMCA 9903.01.04" is a
// Chapter 99 description, and MX is a country.
//
// Reducto merges some line-number cells into the invoice-number cell and the
// code is simply gone from the text ("Invoice Number 001/EXP…-MLM"); for
// those, a declared 9903.01.04 / 9903.01.14 ($0, "goods of Mexico / Canada
// entered free under general note 11") is itself the USMCA claim, and the
// line takes "S" from it. Pure; the processor passes the parse text.

import type { PortEntryExtraction } from "./types";

/** General note 3(c)(i) symbols a broker prints as the column-27 prefix.
 *  Markers travel with the GSP family ("A*", "A+") and USMCA ("S+"). */
export const SPI_SYMBOLS: ReadonlySet<string> = new Set([
  "A", "A*", "A+", "AU", "B", "BH", "C", "CL", "CO", "D", "E", "E*", "IL",
  "J", "J*", "J+", "JO", "K", "KR", "L", "MA", "NP", "OM", "P", "P+", "PA",
  "PE", "R", "S", "S+", "SG",
]);

// A declared IEEPA heading whose article text is a USMCA claim, keyed to
// the origin it names.
const USMCA_HEADINGS: Record<string, string> = {
  "9903.01.04": "MX",
  "9903.01.14": "CA",
};

// Origin / export markers Sobel prints beside the line number ("O,IL").
const MARKER = /^[A-Z],[A-Z]{2}$/;
const NUMBER = /^0*\d{1,3}$/;
// Units a bare number is followed by when the cell is a quantity, not a
// line number ("5 KG").
const UNIT = /^(KG|NO|PCS|LB|L|M|GR|DOZ|PRS|X)$/;

export type LineRef = { line_number: number; hts_code: string };

/** The parse text as a flat sequence of table cells, in document order.
 *  Reducto renders the 7501's line block as an HTML table (and some
 *  brokers' printouts as markdown pipes); either way each cell becomes one
 *  whitespace-collapsed string. */
export function splitCells(text: string): string[] {
  return text
    .replace(/<\/?t[dh][^>]*>/gi, "\u0001")
    .replace(/<[^>]+>/g, " ")
    .split(/\u0001|\|/)
    .map((s) => s.replace(/\s+/g, " ").trim());
}

/** Matches the HTS number as a broker prints it (dotted, spaced, or bare
 *  digits), never inside a longer digit run. */
function htsPattern(htsCode: string): RegExp | null {
  const d = htsCode.replace(/\D/g, "");
  if (d.length < 8) return null;
  const groups = [d.slice(0, 4), d.slice(4, 6), d.slice(6, 8), d.slice(8)].filter(
    (g) => g.length > 0,
  );
  return new RegExp(`(^|[^\\d])(${groups.join("[.\\s]?")})(?![\\d])`);
}

/** A cell made only of line numbers, origin/export markers and symbols —
 *  the line-number cell in every rendering we have seen, merged or not. */
function isLineNumberCell(cell: string): boolean {
  if (cell === "") return false;
  return cell
    .split(" ")
    .every((t) => NUMBER.test(t) || MARKER.test(t) || SPI_SYMBOLS.has(t));
}

const isLineNumber = (token: string, n: number) =>
  NUMBER.test(token) && Number(token) === n;

/** The symbol each line prints, by line number. Lines whose block shows no
 *  symbol, or shows two different ones, are absent. */
export function readLineSpis(
  parseText: string,
  lines: readonly LineRef[],
): Map<number, string> {
  const cells = splitCells(parseText);
  const out = new Map<number, string>();
  let cursor = 0;
  // The last pure line-number cell used: a merged one ("007 O,CN 008 O,IL
  // IL") names the next line too, and sits before this line's cursor.
  let lastLineCell = -1;
  for (const line of [...lines].sort((a, b) => a.line_number - b.line_number)) {
    const pattern = htsPattern(line.hts_code);
    if (!pattern) continue;
    const n = line.line_number;

    // The block start: the line-number cell after the cursor, preferring a
    // pure one over a merged "001 IEEPA-RECIPROCAL …" description cell;
    // never past the line's HTS.
    let start = -1;
    let startIsLineCell = false;
    let loose = -1;
    if (
      lastLineCell >= 0 &&
      cells[lastLineCell].split(" ").some((t) => isLineNumber(t, n))
    ) {
      start = lastLineCell;
      startIsLineCell = true;
    }
    for (let i = cursor; start < 0 && i < cells.length; i++) {
      const tokens = cells[i].split(" ");
      if (isLineNumberCell(cells[i]) && tokens.some((t) => isLineNumber(t, n))) {
        start = i;
        startIsLineCell = true;
        break;
      }
      if (
        loose < 0 &&
        isLineNumber(tokens[0], n) &&
        tokens.length > 1 &&
        !UNIT.test(tokens[1])
      ) {
        loose = i;
      }
      if (pattern.test(cells[i])) break;
    }
    if (start < 0) start = loose;
    if (startIsLineCell) lastLineCell = start;

    // The block proper never reaches back before the cursor, even when
    // its line-number cell (shared with the previous line) does.
    const from = Math.max(start, cursor);
    let hit = -1;
    for (let i = from; i < cells.length; i++) {
      if (pattern.test(cells[i])) {
        hit = i;
        break;
      }
    }
    if (hit < 0) continue;
    const candidates = new Set<string>();

    // Inline, immediately before the HTS in its own cell.
    const match = pattern.exec(cells[hit])!;
    const before = cells[hit].slice(0, match.index + match[1].length);
    const inline = /(?:^|\s)([A-Z]{1,2}[*+]?)\s*$/.exec(before);
    if (inline && SPI_SYMBOLS.has(inline[1])) candidates.add(inline[1]);

    // The cell right before the HTS cell: a lone symbol, or a line-number
    // cell carrying one (its printed number may disagree with the
    // extractor's numbering — position decides).
    let p = hit - 1;
    while (p >= 0 && cells[p] === "") p--;
    if (p >= from) {
      if (SPI_SYMBOLS.has(cells[p])) candidates.add(cells[p]);
      else if (p !== start && isLineNumberCell(cells[p])) {
        for (const t of cells[p].split(" ")) if (SPI_SYMBOLS.has(t)) candidates.add(t);
      }
    }

    // The line-number cell: symbols after this line's number, up to the
    // next line's number; markers skipped.
    if (startIsLineCell) {
      const tokens = cells[start].split(" ");
      const at = tokens.findIndex((t) => isLineNumber(t, n));
      for (const t of tokens.slice(at + 1)) {
        if (NUMBER.test(t)) break;
        if (MARKER.test(t)) continue;
        if (SPI_SYMBOLS.has(t)) candidates.add(t);
      }
    }

    // Sobel's layout, proven by an origin marker in the block: a lone
    // symbol cell (or a marker cell carrying one) anywhere in the block.
    if (candidates.size === 0 && start >= 0) {
      let markerSeen = cells[start].split(" ").some((t) => MARKER.test(t));
      for (let i = from; i < hit; i++) {
        if (cells[i].split(" ").some((t) => MARKER.test(t))) markerSeen = true;
      }
      if (markerSeen) {
        for (let i = Math.max(start + 1, from); i < hit; i++) {
          const cell = cells[i];
          if (SPI_SYMBOLS.has(cell)) candidates.add(cell);
          else if (
            isLineNumberCell(cell) &&
            !cell.split(" ").some((t) => NUMBER.test(t))
          ) {
            for (const t of cell.split(" ")) if (SPI_SYMBOLS.has(t)) candidates.add(t);
          }
        }
      }
    }

    if (candidates.size === 1) out.set(n, [...candidates][0]);
    cursor = hit + 1;
  }
  return out;
}

/** The USMCA claim a line makes by declaring the $0 IEEPA heading for
 *  USMCA-qualifying goods of its origin, when the text prints no symbol. */
function headingImpliedSpi(
  line: PortEntryExtraction["line_items"][number],
): string | null {
  const coo = line.country_of_origin?.toUpperCase() ?? null;
  for (const charge of line.charges) {
    const origin = charge.hts_code ? USMCA_HEADINGS[charge.hts_code] : undefined;
    if (origin && coo === origin) return "S";
  }
  return null;
}

/** The extraction with every blank line SPI filled from the parse text,
 *  else from a declared USMCA heading. A symbol the extractor did return
 *  stands (0 of 81 re-reads disagreed); the same object comes back when
 *  nothing changed. */
export function fillEntryLineSpis(
  fields: PortEntryExtraction,
  parseText: string | null,
): PortEntryExtraction {
  const blank = fields.line_items.filter((line) => !line.spi);
  if (blank.length === 0) return fields;
  const printed = parseText ? readLineSpis(parseText, blank) : new Map<number, string>();
  let changed = false;
  const line_items = fields.line_items.map((line) => {
    if (line.spi) return line;
    const spi = printed.get(line.line_number) ?? headingImpliedSpi(line);
    if (!spi) return line;
    changed = true;
    return { ...line, spi };
  });
  return changed ? { ...fields, line_items } : fields;
}
