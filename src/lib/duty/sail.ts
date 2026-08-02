// Resolves an entry's sail window from its linked shipments. Pure — the
// callers (auditor, entry queries, stub processor) load the shipments.
//
// Entries link to shipments many-to-many and line items carry no shipment
// reference, so the best defensible resolution is entry-level: the min/max
// laden date across every linked shipment. A measure's sail gate then drops
// the measure only when provably no shipment falls in its window, and
// reports anything less certain as an assumption (calculator.ts).

import type { SailInfo } from "./types";

export type SailSource = {
  sailedOnBoardDate: string | null; // BOL shipped-on-board notation
  etd: string | null; // estimate, used as flagged fallback
};

export function resolveSailInfo(shipments: SailSource[]): SailInfo {
  let earliest: string | null = null;
  let latest: string | null = null;
  let estimated = false;

  for (const s of shipments) {
    const sail = s.sailedOnBoardDate ?? s.etd;
    if (sail === null) continue;
    if (s.sailedOnBoardDate === null) estimated = true;
    if (earliest === null || sail < earliest) earliest = sail;
    if (latest === null || sail > latest) latest = sail;
  }

  return { earliestSail: earliest, latestSail: latest, estimated };
}
