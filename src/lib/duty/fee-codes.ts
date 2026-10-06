// CBP's fee class codes as a 7501 prints them: the Block 43 "Other Fee
// Summary" row codes and the pseudo-codes the line-level fee charges carry.
// Beyond MPF/HMF these are the USDA commodity research and promotion
// assessments CBP collects at entry (7 CFR 1205 for cotton, and so on),
// flat per-quantity or ad valorem with no per-entry minimum or maximum. A
// code outside the table is still a fee — it just reads as "Fee".
const FEE_CLASS_LABELS: Record<string, string> = {
  "499": "MPF",
  "501": "HMF",
  "053": "Beef fee",
  "054": "Pork fee",
  "055": "Honey fee",
  "056": "Cotton fee",
  "079": "Sugar fee",
  "090": "Potato fee",
  "102": "Lime fee",
  "103": "Mushroom fee",
  "104": "Watermelon fee",
  "105": "Sheep fee",
  "106": "Blueberry fee",
  "107": "Avocado fee",
  "108": "Mango fee",
  "109": "Sorghum fee",
  "110": "Dairy fee",
};

/** The fee's name for a class code as printed ("056" → "Cotton fee"), or
 *  null when the code is unknown or absent. */
export function feeClassLabel(code: string | null | undefined): string | null {
  if (!code) return null;
  return FEE_CLASS_LABELS[code.replace(/\D/g, "").padStart(3, "0")] ?? null;
}
