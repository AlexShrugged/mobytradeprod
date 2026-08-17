// Pure excerpting of FR notice body text for extraction context. Full
// proclamations run tens of thousands of words (annex tables included);
// what the extractor needs is the prose AROUND the Chapter 99 codes it is
// dating — "subheading 9903.01.20 ... entered for consumption on or after
// February 4, 2025". Windows around code mentions keep the prompt small
// while keeping every verbatim evidence snippet reachable. Codes staged
// from a range clause ("9903.01.01 through 9903.01.15") never appear
// literally, so when no exact code matches, prefix mentions ("9903.01")
// are the fallback anchor.

const WINDOW_CHARS = 1500;
const MAX_MATCHES_PER_ANCHOR = 2;
const MAX_TOTAL_CHARS = 8000;

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function anchorRanges(text: string, anchor: string): [number, number][] {
  const re = new RegExp(escape(anchor), "g");
  const ranges: [number, number][] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null && ranges.length < MAX_MATCHES_PER_ANCHOR) {
    ranges.push([
      Math.max(0, m.index - WINDOW_CHARS),
      Math.min(text.length, m.index + anchor.length + WINDOW_CHARS),
    ]);
  }
  return ranges;
}

/** Merged windows of body text around mentions of the given dotted Ch99
 *  codes (falling back to their 6-digit dotted prefixes), joined with " … "
 *  and capped at MAX_TOTAL_CHARS. Null when nothing in the text mentions
 *  the codes or their prefixes — the notice is irrelevant to this chunk. */
export function clipNoticeForCodes(
  text: string,
  codes: string[],
): string | null {
  let ranges: [number, number][] = [];
  for (const code of codes) ranges.push(...anchorRanges(text, code));
  if (ranges.length === 0) {
    const prefixes = [...new Set(codes.map((c) => c.slice(0, 7)))];
    for (const p of prefixes) ranges.push(...anchorRanges(text, p));
  }
  if (ranges.length === 0) return null;

  ranges.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else merged.push([...r]);
  }

  let out = "";
  for (const [start, end] of merged) {
    if (out.length >= MAX_TOTAL_CHARS) break;
    const slice = text.slice(start, end);
    out = out ? `${out} … ${slice}` : slice;
  }
  return out.slice(0, MAX_TOTAL_CHARS);
}
