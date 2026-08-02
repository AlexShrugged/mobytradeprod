// Regex highlighter for on-the-water / effective-date clauses in Chapter 99
// description text. Output is EVIDENCE for the review UI (<mark> highlights
// with one-click suggestion chips) — nothing here lands in a measure until
// a human confirms it, per the reference-data review doctrine.
//
// Validated against the verbatim 9903.01.23 IEEPA text: "... (1) were
// loaded onto a vessel at the port of loading, or in transit on the final
// mode of transport prior to entry into the United States, before 12:01
// a.m. eastern standard time on February 1, 2025; and (2) are entered for
// consumption, or withdrawn from warehouse for consumption, on or after
// ... February 4, 2025, and before ... March 7, 2025."

import type { SailClauseCandidate, SailClauseKind } from "./types";

const MONTHS: Record<string, string> = {
  january: "01", february: "02", march: "03", april: "04", may: "05",
  june: "06", july: "07", august: "08", september: "09", october: "10",
  november: "11", december: "12",
};

// "February 1, 2025" (long-form month, the FR/USITC house style).
const DATE_RE =
  /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),\s+(\d{4})\b/g;

// Cues examined in the text WINDOW preceding each date. Sail cues beat
// entry cues when both appear because the lading phrase sits closest to
// its own date in the standard clause structure.
const SAIL_CUE =
  /\b(loaded\s+onto\s+a\s+vessel|laden\s+aboard|laden\s+on\s+board|in\s+transit\s+on\s+the\s+final\s+mode)\b/i;
const ENTRY_CUE =
  /\b(entered\s+for\s+consumption|withdrawn\s+from\s+warehouse|date\s+of\s+entry)\b/i;
const ON_OR_AFTER_CUE = /\bon\s+or\s+after\b(?![\s\S]*\b(?:before|prior\s+to)\b)/i;

/** How far back we look for a cue, in characters. Clauses are long-winded
 *  ("before 12:01 a.m. eastern standard time on ...") so the window is
 *  generous, but bounded so cue and date stay in the same clause. */
const WINDOW = 220;

export function findSailClauses(text: string): SailClauseCandidate[] {
  const out: SailClauseCandidate[] = [];

  for (const m of text.matchAll(DATE_RE)) {
    const month = MONTHS[m[1].toLowerCase()];
    if (!month) continue;
    const isoDate = `${m[3]}-${month}-${m[2].padStart(2, "0")}`;

    const start = Math.max(0, m.index - WINDOW);
    const windowText = text.slice(start, m.index + m[0].length);

    const subject: "sail" | "entry" | null = (() => {
      const sailAt = lastIndexOfMatch(windowText, SAIL_CUE);
      const entryAt = lastIndexOfMatch(windowText, ENTRY_CUE);
      if (sailAt === -1 && entryAt === -1) return null;
      return sailAt > entryAt ? "sail" : "entry";
    })();
    if (!subject) continue;

    // Direction: the comparator nearest the date. "on or after" only wins
    // when no later "before"/"prior to" intervenes (see ON_OR_AFTER_CUE).
    const tail = windowText.slice(-120);
    const before = /\b(before|prior\s+to)\b(?![\s\S]*\bon\s+or\s+after\b)/i.test(tail);
    const onOrAfter = ON_OR_AFTER_CUE.test(tail);
    if (!before && !onOrAfter) continue;

    const kind: SailClauseKind =
      subject === "sail"
        ? before
          ? "sail_before"
          : "sail_on_or_after"
        : before
          ? "entry_before"
          : "entry_on_or_after";

    const snippetStart = Math.max(0, m.index - 80);
    out.push({
      kind,
      isoDate,
      snippet: `${snippetStart > 0 ? "…" : ""}${text.slice(snippetStart, m.index + m[0].length)}`,
      index: m.index,
    });
  }

  return out;
}

function lastIndexOfMatch(text: string, re: RegExp): number {
  const global = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
  let last = -1;
  for (const m of text.matchAll(global)) last = m.index;
  return last;
}
