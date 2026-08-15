// AD/CVD order corpus seed — fictional orders consistent with the story
// world, shaped so the analyst can actually adjudicate the seeded AD/CVD
// facts instead of only noticing them:
//   - A-570-121 covers the lithium battery packs on entry 231-4501358-3;
//     its all-others deposit rate (25.47%) matches the declared antidumping
//     charge, and the supplier of record has a LOWER producer rate — so the
//     open producer question is real money in both directions.
//   - A-570-133 (the case the invoice prints) covers hub motors, not
//     batteries — the corpus resolves which side of the case-number
//     conflict is the typo.
//   - C-570-122 is the companion CVD order on the same merchandise; the
//     entry declares no countervailing deposit at all.
//   - The rest exist so the corpus reads like a corpus: an order the org's
//     book never touches, and a revoked one.
// Dates are historical fixtures (long-standing orders), not relative — they
// cannot go stale the way entry dates would.

import type * as schema from "../schema";

type AdcvdOrderSeed = Omit<
  typeof schema.adcvdOrders.$inferInsert,
  "id" | "createdAt" | "updatedAt"
>;

export const ADCVD_ORDER_SEED: AdcvdOrderSeed[] = [
  {
    caseNumber: "A-570-121",
    country: "CN",
    merchandise: "Lithium-Ion Battery Packs and Modules",
    scopeSummary:
      "Rechargeable lithium-ion battery packs and modules of a nominal voltage of 36V or higher, designed for light electric vehicles (including electric bicycles), whether or not assembled with a battery management system, from the People's Republic of China. Cells imported separately for pack assembly in the United States are outside the scope.",
    htsPrefixes: ["8507.60"],
    status: "active",
    effectiveDate: "2023-05-18",
    revokedDate: null,
    depositRates: [
      { producer: "Shenzhen Volt Dynamics", rate: 0.1783 },
      { producer: null, rate: 0.2547 },
    ],
    source: "88 FR 31842 (seed approximation)",
  },
  {
    caseNumber: "C-570-122",
    country: "CN",
    merchandise: "Lithium-Ion Battery Packs and Modules",
    scopeSummary:
      "Companion countervailing duty order to A-570-121; identical scope. Rechargeable lithium-ion battery packs and modules of a nominal voltage of 36V or higher, designed for light electric vehicles, from the People's Republic of China.",
    htsPrefixes: ["8507.60"],
    status: "active",
    effectiveDate: "2023-05-18",
    revokedDate: null,
    depositRates: [
      { producer: "Shenzhen Volt Dynamics", rate: 0.0516 },
      { producer: null, rate: 0.1124 },
    ],
    source: "88 FR 31848 (seed approximation)",
  },
  {
    caseNumber: "A-570-133",
    country: "CN",
    merchandise: "Electric Bicycle Hub Motors",
    scopeSummary:
      "Brushless DC hub motors of an output between 250W and 1,000W, designed for electric bicycles, whether or not assembled with a wheel, from the People's Republic of China. Mid-drive motor units are outside the scope.",
    htsPrefixes: ["8501.31", "8501.32"],
    status: "active",
    effectiveDate: "2024-02-09",
    revokedDate: null,
    depositRates: [
      { producer: "Ningbo Drive Systems", rate: 0.2419 },
      { producer: null, rate: 0.6842 },
    ],
    source: "89 FR 8977 (seed approximation)",
  },
  {
    caseNumber: "A-570-098",
    country: "CN",
    merchandise: "Hand Trucks and Certain Parts Thereof",
    scopeSummary:
      "Hand trucks manufactured from any material, and certain parts thereof (vertical frame, handling area, projecting edges, wheels), from the People's Republic of China.",
    htsPrefixes: ["8716.80"],
    status: "active",
    effectiveDate: "2019-10-02",
    revokedDate: null,
    depositRates: [{ producer: null, rate: 0.4634 }],
    source: "84 FR 52418 (seed approximation)",
  },
  {
    caseNumber: "A-570-104",
    country: "CN",
    merchandise: "Pedal-Assist Drive Units",
    scopeSummary:
      "Integrated pedal-assist drive units for electric bicycles, from the People's Republic of China. Revoked following a changed-circumstances review; no deposits are required on entries after the revocation date.",
    htsPrefixes: ["8501.31"],
    status: "revoked",
    effectiveDate: "2020-07-14",
    revokedDate: "2024-11-03",
    depositRates: [{ producer: null, rate: 0.3391 }],
    source: "89 FR 71255 (seed approximation)",
  },
];
