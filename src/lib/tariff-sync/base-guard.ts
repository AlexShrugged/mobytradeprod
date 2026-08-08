// Truncation/anomaly guard over a base-release diff. The legacy platform
// treated absence as removal with no floor under it, so one short USITC
// response silently deactivated most of the schedule; every threshold here
// exists to make that class of failure loud instead. A failed guard blocks
// apply unless the reviewer explicitly forces it (their call to make — the
// guard is a tripwire, not a verdict).
//
// Relative imports on purpose — reachable from the tsx seed script.

import type { BaseDiff, BaseReleaseSanity } from "./types";

/** A full HTS base schedule is ~30k coded rows; far fewer means the fetch
 *  or the parse lost most of the release. Applies unconditionally. */
export const MIN_PREPARED_ROWS = 5_000;

/** Below this many current windows the reference is a bootstrap subset (the
 *  23-row demo seed) and the relative checks would only compare noise —
 *  the first certified release SHOULD replace nearly everything. */
export const ESTABLISHED_MIN_ROWS = 1_000;

/** Established schedule losing more than this share of codes in one release
 *  is a truncated fetch until a human says otherwise. */
export const MAX_REMOVED_SHARE = 0.1;

/** A release parsing to under this fraction of the current row count is a
 *  shrunken payload. */
export const MIN_PREPARED_RATIO = 0.8;

/** More than this share of rows changing rate/description in one release
 *  smells like a rate-parse regression, not a tariff act. */
export const MAX_CHANGED_SHARE = 0.5;

export function checkBaseReleaseSanity(
  diff: BaseDiff,
  preparedCount: number,
  currentCount: number,
): BaseReleaseSanity {
  const reasons: string[] = [];

  if (preparedCount < MIN_PREPARED_ROWS) {
    reasons.push(
      `Release parsed to ${preparedCount.toLocaleString()} rows; a full HTS base schedule is ~30k — suspected truncated fetch.`,
    );
  }

  if (currentCount >= ESTABLISHED_MIN_ROWS) {
    const removedShare = diff.removed.length / currentCount;
    if (removedShare > MAX_REMOVED_SHARE) {
      reasons.push(
        `${diff.removed.length.toLocaleString()} of ${currentCount.toLocaleString()} current codes (${Math.round(removedShare * 100)}%) would be removed — suspected truncated fetch.`,
      );
    }
    if (preparedCount < currentCount * MIN_PREPARED_RATIO) {
      reasons.push(
        `Release carries ${preparedCount.toLocaleString()} rows against ${currentCount.toLocaleString()} current — shrunken payload.`,
      );
    }
    const changedShare = diff.changed.length / currentCount;
    if (changedShare > MAX_CHANGED_SHARE) {
      reasons.push(
        `${diff.changed.length.toLocaleString()} of ${currentCount.toLocaleString()} current codes (${Math.round(changedShare * 100)}%) would change — possible rate-parse regression.`,
      );
    }
  }

  return { ok: reasons.length === 0, reasons };
}
