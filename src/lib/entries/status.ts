// Entry lifecycle state, DERIVED on read — never stored. An entry row only
// exists because a 7501 entry summary was processed, so every entry is
// "filed" by construction; "liquidated" derives from the one liquidation
// evidence we ingest, the liquidation date printed on ACE refund report
// rows (refund_claims.liquidation_date). "released" was dropped outright:
// no document class we ingest carries CBP release evidence, so it could
// never be shown honestly.
//
// Relative imports on purpose — reachable from the tsx seed script.

export type DerivedEntryStatus = "filed" | "liquidated";

export function deriveEntryStatus(
  claims: { liquidationDate: string | null }[],
  today: string,
): DerivedEntryStatus {
  return claims.some(
    (c) => c.liquidationDate !== null && c.liquidationDate <= today,
  )
    ? "liquidated"
    : "filed";
}
