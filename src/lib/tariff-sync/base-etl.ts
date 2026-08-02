// Pure base-schedule ETL (ports moby's HtsScheduleEtl algorithm): walk the
// ordered USITC rows with an indent stack to recover the hierarchy, then
//   - link each coded row to its nearest CODED ancestor (parent_digits);
//     codeless decision-branch rows ("Other:") stay on the stack for context
//     but are NEVER emitted as db rows, and never become parents;
//   - inherit a rate from the nearest rate-bearing ancestor when a row's
//     own rate cells are blank (standard HTSUS structure: the rate is
//     stated once on the subheading; 10-digit statistical suffixes are
//     blank), recording rate_inherited_from;
//   - keep chapters 1–97 only (98/99 belong to the measure pipeline);
// and diff the prepared rows against the current base windows. No IO — the
// write path is base-apply.ts.

import { parseBaseRate } from "./rate-parse";
import type {
  BaseDiff,
  BaseScheduleRow,
  CurrentBaseWindow,
  ParsedBaseRate,
  PreparedBaseRow,
} from "./types";

type StackNode = {
  indent: number;
  /** null for codeless decision-branch rows. */
  codeDigits: string | null;
  /** This row's OWN parsed rate; null when its rate cells were blank. */
  parsed: ParsedBaseRate | null;
  /** The raw general text backing `parsed`, for inherited col1_general. */
  rawGeneral: string | null;
};

/** Indent-stack walk producing one PreparedBaseRow per coded, in-scope row.
 *  Duplicate codes keep the LAST occurrence (upsert semantics, matching the
 *  legacy ETL's unique-key behavior). */
export function prepareBaseRows(rows: BaseScheduleRow[]): PreparedBaseRow[] {
  const stack: StackNode[] = [];
  const byDigits = new Map<string, PreparedBaseRow>();

  for (const row of rows) {
    const indent = row.indent;
    // Pop siblings/deeper nodes so the stack top is this row's ancestor.
    while (stack.length > 0 && stack[stack.length - 1].indent >= indent) {
      stack.pop();
    }

    const code = row.htsno.trim();
    const digits = code.replace(/\D/g, "");
    const ownGeneral = row.general.trim();
    const ownParsed = ownGeneral !== "" ? parseBaseRate(ownGeneral) : null;

    const node: StackNode = {
      indent,
      codeDigits: code === "" ? null : digits,
      parsed: ownParsed,
      rawGeneral: ownParsed ? ownGeneral : null,
    };

    // Nearest coded ancestor and nearest rate-bearing ancestor (which may
    // legitimately be a codeless branch row carrying rate cells).
    let parentDigits: string | null = null;
    let rateAncestor: StackNode | null = ownParsed ? node : null;
    for (let i = stack.length - 1; i >= 0; i--) {
      if (parentDigits === null && stack[i].codeDigits !== null) {
        parentDigits = stack[i].codeDigits;
      }
      if (rateAncestor === null && stack[i].parsed !== null) {
        rateAncestor = stack[i];
      }
      if (parentDigits !== null && rateAncestor !== null) break;
    }

    stack.push(node);

    if (code === "") continue; // codeless: context only
    const chapter = Number(digits.slice(0, 2));
    if (!(chapter >= 1 && chapter <= 97)) continue;

    const inherited = ownParsed === null && rateAncestor !== null;
    const parsed = ownParsed ?? rateAncestor?.parsed ?? null;

    byDigits.set(digits, {
      code,
      codeDigits: digits,
      chapter,
      description: row.description.trim(),
      indent,
      parentDigits,
      // A row with no rate anywhere up its chain (e.g. a bare heading) is
      // display-only: rate null, type "other".
      rateType: parsed?.rateType ?? "other",
      rate: parsed?.rate ?? null,
      col1General: ownParsed
        ? ownGeneral
        : inherited
          ? rateAncestor!.rawGeneral
          : null,
      col1Special: row.special.trim() || null,
      col2Rate: row.other.trim() || null,
      unitOfQuantity: row.unitOfQuantity.trim() || null,
      rateInheritedFrom: inherited ? rateAncestor!.codeDigits : null,
    });
  }

  return [...byDigits.values()];
}

/** Diff prepared rows against the current windows. changed = computable
 *  rate OR normalized description differs; absence = removal (USITC has no
 *  change feed). Rate inheritance makes this cascade correctly: when a
 *  subheading's rate changes, its inheriting statistical leaves change too
 *  and show up here on their own digits. */
export function diffBaseRelease(
  prepared: PreparedBaseRow[],
  current: CurrentBaseWindow[],
): BaseDiff {
  const currentByDigits = new Map(current.map((c) => [c.codeDigits, c]));
  const added: PreparedBaseRow[] = [];
  const changed: BaseDiff["changed"] = [];
  let unchanged = 0;
  const seen = new Set<string>();

  for (const row of prepared) {
    seen.add(row.codeDigits);
    const live = currentByDigits.get(row.codeDigits);
    if (!live) {
      added.push(row);
      continue;
    }
    if (
      rateDiffers(row.rate, live.rate) ||
      normalizeText(row.description) !== normalizeText(live.description)
    ) {
      changed.push({ row, current: live });
    } else {
      unchanged += 1;
    }
  }

  const removed = current.filter((c) => !seen.has(c.codeDigits));
  return { added, changed, removed, unchanged };
}

export function runBaseEtl(
  rows: BaseScheduleRow[],
  current: CurrentBaseWindow[],
): { prepared: PreparedBaseRow[]; diff: BaseDiff } {
  const prepared = prepareBaseRows(rows);
  return { prepared, diff: diffBaseRelease(prepared, current) };
}

function rateDiffers(a: number | null, b: number | null): boolean {
  if (a === null || b === null) return (a === null) !== (b === null);
  return Math.abs(a - b) > 1e-9;
}

function normalizeText(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}
