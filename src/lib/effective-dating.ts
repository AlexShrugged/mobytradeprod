// Shared effective-dating primitives for change-tiled windows
// (valid_from/valid_to date pairs: null from = open start, null to =
// current). Used by the tariff base-schedule windows, Ch99 measure windows,
// part classification windows, and part_sources windows so every dataset
// tiles and resolves the same way. Pure functions only — no IO.
//
// Relative imports on purpose — reachable from the tsx seed script.

export type Windowed = {
  validFrom: string | null;
  validTo: string | null;
};

/** The day before an ISO date, UTC-safe. */
export function dayBefore(isoDate: string): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

export type WindowPlan =
  | { action: "tile"; closePredecessorAt: string }
  | { action: "update_in_place" };

/** Pure tiling decision for a changed value with a known effective date. A
 *  successor window opens at the effective date, closing its predecessor at
 *  eff − 1; when the effective date does not post-date the current window's
 *  start, the "change" is a correction of that window and is updated in
 *  place (tiling would mint an inverted or zero-length window). */
export function planWindow(
  currentValidFrom: string | null,
  effectiveDate: string,
): WindowPlan {
  if (currentValidFrom === null || effectiveDate > currentValidFrom) {
    return { action: "tile", closePredecessorAt: dayBefore(effectiveDate) };
  }
  return { action: "update_in_place" };
}

/** Pure close-date decision for a retired window: the last valid day is the
 *  day before the close takes effect, clamped to the window's own start so a
 *  same-day close collapses to a one-day window instead of an inverted
 *  range. */
export function planCloseDate(
  currentValidFrom: string | null,
  effectiveDate: string,
): string {
  const closeAt = dayBefore(effectiveDate);
  if (currentValidFrom !== null && closeAt < currentValidFrom) {
    return currentValidFrom;
  }
  return closeAt;
}

export type CommitWindowPlan =
  | { action: "insert_first"; validFrom: string | null }
  | { action: "tile"; closePredecessorAt: string }
  | { action: "update_in_place" };

/** Commit planner for human-dated facts (part classifications, sourcing
 *  facts). The effective date carries the intent:
 *  - null ("no date given") = a CORRECTION — "this value was always right":
 *    the current window is updated in place, history is rewritten.
 *  - a date = a RECLASSIFICATION — "the value changes from this day
 *    forward": tile, unless the date does not post-date the current
 *    window's start (then it corrects that window, per planWindow).
 *  With no current window, the value's first window opens at the effective
 *  date (null = open start). */
export function planCommitWindow(
  current: { validFrom: string | null } | null,
  effectiveDate: string | null,
): CommitWindowPlan {
  if (current === null) {
    return { action: "insert_first", validFrom: effectiveDate };
  }
  if (effectiveDate === null) {
    return { action: "update_in_place" };
  }
  return planWindow(current.validFrom, effectiveDate);
}

/** As-of window resolution, mirroring resolveBaseSchedule
 *  (duty/calculator.ts): the window containing asOf wins (bounds inclusive;
 *  a null validFrom matches every earlier date). A null asOf, or a date no
 *  window contains, falls back to the CURRENT (validTo null) window — so
 *  undated entries and entries predating the first recorded window behave
 *  exactly as they did before windowing existed. No current window (all
 *  closed) → undefined. Windows never overlap, so input order is free. */
export function resolveWindow<T extends Windowed>(
  windows: readonly T[],
  asOf: string | null,
): T | undefined {
  if (asOf !== null) {
    const hit = windows.find(
      (w) =>
        (w.validFrom === null || w.validFrom <= asOf) &&
        (w.validTo === null || asOf <= w.validTo),
    );
    if (hit) return hit;
  }
  return windows.find((w) => w.validTo === null);
}
