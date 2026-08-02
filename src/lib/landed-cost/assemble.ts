import type { CostComponent, CostComponentKind, LandedCost } from "./types";

// Kinds that exist as real importer costs but have no data source yet. They
// surface in `excluded` so every UI can say what a landed figure leaves out.
const FUTURE_KINDS: readonly CostComponentKind[] = [
  "freight",
  "insurance",
  "brokerage",
];

/** Fold a component stack into a LandedCost. The single rounding rule lives
 * here: the total is the exact sum of non-null component cents; per-unit is
 * derived display rounding and must never be multiplied back out. */
export function assembleLandedCost(
  components: CostComponent[],
  quantity: number | null,
): LandedCost {
  let totalCents = 0;
  let incomplete = false;
  const included: CostComponentKind[] = [];

  for (const c of components) {
    if (c.amountCents === null) {
      incomplete = true;
    } else {
      totalCents += c.amountCents;
    }
    if (!included.includes(c.kind)) included.push(c.kind);
  }

  return {
    components,
    totalCents,
    quantity,
    perUnitCents:
      quantity !== null && quantity > 0
        ? Math.round(totalCents / quantity)
        : null,
    incomplete,
    included,
    excluded: FUTURE_KINDS.filter((k) => !included.includes(k)),
  };
}
