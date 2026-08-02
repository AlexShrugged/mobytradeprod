// Landed cost as an explicit stack of cost components. Duty-inclusive today
// (merchandise + duty stack + MPF/HMF-class fees); freight, insurance, and
// brokerage are pre-declared kinds so future ingested costs slot into the
// same shape via the `extraComponents` parameter on the assembly functions —
// no consumer changes needed. Money is integer cents throughout.

export type CostComponentKind =
  | "merchandise"
  | "duty"
  | "fee"
  // Not tracked yet — reserved for future ingested cost facts.
  | "freight"
  | "insurance"
  | "brokerage"
  | "other";

export type CostComponentSource = "declared" | "computed" | "estimated";

export type CostComponent = {
  kind: CostComponentKind;
  label: string; // "Base duty (4%)", "Section 301 List 1 — China", "MPF"
  // null = the component is known to exist but is not computable
  // (specific/compound rate, HTS missing from reference data).
  amountCents: number | null;
  source: CostComponentSource;
  rate?: number | null; // decimal fraction, when rate-derived
  note?: string; // caveats: MPF/HMF caps, suppression, unknown HTS
};

export type LandedCost = {
  components: CostComponent[];
  // Exact sum of the non-null component amounts. Never derived from
  // perUnitCents — per-unit is display-only rounding.
  totalCents: number;
  quantity: number | null;
  perUnitCents: number | null; // null when quantity is null or <= 0
  // True when any component amount is null — the total understates cost.
  incomplete: boolean;
  included: CostComponentKind[];
  excluded: CostComponentKind[]; // known kinds we do not track yet
};
