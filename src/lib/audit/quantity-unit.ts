// Quantity units of measure: the 7501 declares a line's NET QUANTITY IN
// HTSUS UNITS (column 32 — kilograms for most metal goods, "No." for
// counted goods), while a commercial invoice bills in whatever the seller
// counts (pieces, sets, pairs, kilograms). Two quantities are comparable
// only when both sides resolve to the same unit family; a kg line against a
// piece-count invoice is not a variance, it is two measurements of different
// things. Pure — no DB, no IO; shared by the audit rules, the analyst
// briefing, and the read side.
//
// Relative imports on purpose — this module runs under the tsx seed script.

/** Canonical unit families. `x` is the HTSUS "no quantity required" marker
 *  — a line reporting under it carries no comparable quantity at all. */
export type QuantityUnit =
  | "no"
  | "kg"
  | "g"
  | "t"
  | "doz"
  | "prs"
  | "dpr"
  | "set"
  | "m"
  | "m2"
  | "m3"
  | "l"
  | "x";

// Spellings seen on 7501 printouts (ABI codes), commercial invoices, and the
// USITC schedule's units column, keyed after lowercasing and stripping
// periods, plural "s", and surrounding whitespace.
const ALIASES: Record<string, QuantityUnit> = {
  // counted goods
  no: "no",
  nos: "no",
  number: "no",
  pc: "no",
  pcs: "no",
  pce: "no",
  piece: "no",
  ea: "no",
  each: "no",
  unit: "no",
  u: "no",
  // weight
  kg: "kg",
  kgs: "kg",
  kgm: "kg",
  kilo: "kg",
  kilogram: "kg",
  "kg cmsc": "kg", // kg of cane/sugar content — still kilograms
  g: "g",
  gr: "g",
  gram: "g",
  t: "t",
  ton: "t",
  tonne: "t",
  mt: "t",
  "metric ton": "t",
  // grouped counts
  doz: "doz",
  dozen: "doz",
  dz: "doz",
  pr: "prs",
  prs: "prs",
  pair: "prs",
  dpr: "dpr",
  "doz pr": "dpr",
  "doz prs": "dpr",
  "dozen pair": "dpr",
  set: "set",
  // length / area / volume
  m: "m",
  mtr: "m",
  meter: "m",
  metre: "m",
  m2: "m2",
  "m²": "m2",
  sqm: "m2",
  "sq m": "m2",
  "square meter": "m2",
  "square metre": "m2",
  m3: "m3",
  "m³": "m3",
  cbm: "m3",
  "cubic meter": "m3",
  "cubic metre": "m3",
  l: "l",
  ltr: "l",
  liter: "l",
  litre: "l",
  // no quantity required
  x: "x",
};

/** Normalize one printed unit ("KG", "pcs.", "No.", "Kilograms") to its
 *  family; null when the spelling is unknown — unknown never compares. */
export function normalizeQuantityUnit(
  raw: string | null | undefined,
): QuantityUnit | null {
  if (!raw) return null;
  let key = raw
    .toLowerCase()
    .replace(/\./g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!key) return null;
  if (key in ALIASES) return ALIASES[key];
  // Plurals: "pieces", "kilograms", "sets", "pairs", "dozens", "meters".
  if (key.endsWith("s") && key.slice(0, -1) in ALIASES)
    return ALIASES[key.slice(0, -1)];
  // Parenthesized or slashed qualifiers: "PCS (EA)", "KG/NET".
  key = key.replace(/\s*[(/].*$/, "").trim();
  if (key in ALIASES) return ALIASES[key];
  if (key.endsWith("s") && key.slice(0, -1) in ALIASES)
    return ALIASES[key.slice(0, -1)];
  return null;
}

/** The distinct unit families an HTS reporting-unit string names. USITC
 *  prints two-unit codes as "No., kg" / "doz., kg" — the 7501 then reports
 *  BOTH figures, and a single extracted number cannot be attributed. */
export function parseHtsReportingUnits(
  text: string | null | undefined,
): QuantityUnit[] {
  if (!text) return [];
  const units: QuantityUnit[] = [];
  for (const part of text.split(",")) {
    const unit = normalizeQuantityUnit(part);
    if (unit && !units.includes(unit)) units.push(unit);
  }
  return units;
}

/** The unit a 7501 line's quantity is expressed in: the code printed next
 *  to the figure when the extraction captured one, else the schedule's
 *  reporting unit for the classification — column 32 is "net quantity in
 *  HTSUS units" by definition, so a single-unit code names the unit even
 *  for extractions predating unit capture. A two-unit code is ambiguous
 *  without the printed code, and an "X" (no quantity required) line has no
 *  comparable quantity: both resolve to null. */
export function resolveEntryLineUnit(
  declared: string | null | undefined,
  htsReportingUnit: string | null | undefined,
): QuantityUnit | null {
  const own = normalizeQuantityUnit(declared);
  if (own) return own === "x" ? null : own;
  const fromSchedule = parseHtsReportingUnits(htsReportingUnit);
  if (fromSchedule.length !== 1) return null;
  return fromSchedule[0] === "x" ? null : fromSchedule[0];
}

/** The unit an invoice line's quantity is expressed in — only what the
 *  invoice itself prints; an invoice with no unit is not comparable. */
export function resolveInvoiceLineUnit(
  declared: string | null | undefined,
): QuantityUnit | null {
  const unit = normalizeQuantityUnit(declared);
  return unit === "x" ? null : unit;
}

const LABELS: Record<QuantityUnit, string> = {
  no: "pcs",
  kg: "kg",
  g: "g",
  t: "t",
  doz: "doz",
  prs: "prs",
  dpr: "doz prs",
  set: "sets",
  m: "m",
  m2: "m²",
  m3: "m³",
  l: "L",
  x: "",
};

/** Short display label for a unit family ("kg", "pcs", "m²"). */
export function quantityUnitLabel(unit: QuantityUnit | null): string {
  return unit ? LABELS[unit] : "";
}

/** "1,065 kg" / "1,500 pcs" / "1,065" when the unit is unknown. */
export function formatQuantity(
  quantity: number | string | null | undefined,
  unit: QuantityUnit | null,
): string {
  if (quantity === null || quantity === undefined || quantity === "")
    return "—";
  const n = Number(quantity);
  const num = Number.isFinite(n)
    ? n.toLocaleString("en-US", { maximumFractionDigits: 4 })
    : String(quantity);
  const label = quantityUnitLabel(unit);
  return label ? `${num} ${label}` : num;
}
