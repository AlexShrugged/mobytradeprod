// Tariff reference seed: the HTS schedule subset covering the demo parts
// catalog, a small realistic set of Chapter 99 trade measures, and the
// stacking rules between them. This module is the single source of truth —
// scripts/seed.ts loads it into the DB, and the stub processor and the
// calculator tests use it directly in memory. The USITC sync replaces
// exactly this file's data.
//
// Ported from mobynew with ONE deliberate change: the Section 122 sail-tiled
// measure pair is parameterized RELATIVE TO SEED DAY (buildMeasureSeed takes
// a day() helper) so the on-the-water demo never goes stale.
//
// MFN rates are plausible approximations for demo purposes, not certified
// USITC values.

// Relative imports on purpose: this module is loaded by the tsx-run seed
// script, which must not depend on bundler path aliases.
import { normalizeHts } from "../../duty/calculator";
import type {
  HtsRef,
  MeasureRef,
  ReferenceData,
  StackingRuleRef,
} from "../../duty/types";
import type {
  HtsRateTypeValue,
  MeasureAuthorityValue,
  MeasureScopeValue,
} from "../schema";

/** ISO date `offset` days from seed day (negative = past). */
export type DayFn = (offset: number) => string;

// MPF/HMF are ingested facts on entries, never computed downstream. These
// nominal rates exist for the seed's fabricated declared values, the stub
// processor, and *estimated* landed cost, which applies them uncapped with
// an explicit caveat (CBP per-entry minimums/caps are unknowable per part).
export const MPF_RATE = 0.003464;
export const HMF_RATE = 0.00125;

// Base-schedule window metadata for seed rows: one open-ended window per
// code (valid_to null = current), stamped with a synthetic release id so
// the tariff sync's change-tiling has a baseline to succeed.
export const BASE_VALID_FROM = "2025-01-01";
export const BASE_RELEASE = "SEED";

export type HtsSeed = {
  code: string;
  description: string;
  rateType: HtsRateTypeValue;
  rate: number | null; // decimal fraction
  col1General: string;
};

export const HTS_SEED: HtsSeed[] = [
  { code: "4011.50.0000", description: "New pneumatic tires, of rubber, of a kind used on bicycles", rateType: "free", rate: 0, col1General: "Free" },
  { code: "4013.20.0000", description: "Inner tubes, of rubber, of a kind used on bicycles", rateType: "free", rate: 0, col1General: "Free" },
  { code: "7315.11.0045", description: "Roller chain of iron or steel, bicycle", rateType: "free", rate: 0, col1General: "Free" },
  { code: "7318.15.8085", description: "Other screws and bolts, of iron or steel, with hexagonal heads", rateType: "ad_valorem", rate: 0.085, col1General: "8.5%" },
  { code: "8501.31.4000", description: "DC motors, of an output exceeding 74.6 W but not exceeding 735 W", rateType: "ad_valorem", rate: 0.04, col1General: "4%" },
  { code: "8504.40.9550", description: "Static converters (inverters), other", rateType: "free", rate: 0, col1General: "Free" },
  { code: "8507.60.0020", description: "Lithium-ion storage batteries, other", rateType: "ad_valorem", rate: 0.034, col1General: "3.4%" },
  { code: "8512.10.2000", description: "Lighting equipment of a kind used on bicycles", rateType: "free", rate: 0, col1General: "Free" },
  { code: "8531.20.0040", description: "Indicator panels incorporating LCD or LED displays", rateType: "free", rate: 0, col1General: "Free" },
  { code: "8714.91.3000", description: "Bicycle frames, of aluminum alloy", rateType: "ad_valorem", rate: 0.039, col1General: "3.9%" },
  { code: "8714.91.5000", description: "Bicycle forks", rateType: "ad_valorem", rate: 0.039, col1General: "3.9%" },
  { code: "8714.92.1000", description: "Wheel rims for bicycles", rateType: "ad_valorem", rate: 0.05, col1General: "5%" },
  { code: "8714.93.3500", description: "Free-wheel sprocket-wheels for bicycles", rateType: "free", rate: 0, col1General: "Free" },
  { code: "8714.94.3080", description: "Brakes for bicycles, other than coaster brakes", rateType: "free", rate: 0, col1General: "Free" },
  { code: "8714.94.9000", description: "Parts of bicycle brakes", rateType: "ad_valorem", rate: 0.1, col1General: "10%" },
  { code: "8714.95.0000", description: "Saddles for bicycles", rateType: "ad_valorem", rate: 0.08, col1General: "8%" },
  { code: "8714.96.5000", description: "Cotterless-type crank sets for bicycles", rateType: "free", rate: 0, col1General: "Free" },
  { code: "8714.96.9000", description: "Pedals and parts thereof, other", rateType: "ad_valorem", rate: 0.1, col1General: "10%" },
  { code: "8714.99.1000", description: "Handlebars and stems for bicycles", rateType: "ad_valorem", rate: 0.1, col1General: "10%" },
  { code: "8714.99.5000", description: "Derailleurs and parts thereof", rateType: "free", rate: 0, col1General: "Free" },
  { code: "8714.99.8000", description: "Other parts and accessories of bicycles", rateType: "ad_valorem", rate: 0.1, col1General: "10%" },
  { code: "8714.99.9000", description: "Other parts and accessories of bicycles, other", rateType: "ad_valorem", rate: 0.1, col1General: "10%" },
];

export type MeasureSeed = {
  name: string;
  authority: MeasureAuthorityValue;
  scope: MeasureScopeValue;
  countries: string[] | null;
  effectiveDate: string;
  endDate: string | null;
  // Sail-date conditions (see trade_measures in schema.ts); omitted = none.
  sailedOnOrAfter?: string | null;
  sailedOnOrBefore?: string | null;
  inLieuOfBaseDuty: boolean;
  notes: string | null;
  // Chapter 99 rows belonging to this measure. The measure's rate lives on
  // its (non-exemption) Chapter 99 row, never on the measure itself.
  ch99: {
    code: string;
    description: string;
    rate: number;
    exemption: boolean;
  }[];
  prefixes: string[];
};

/** "March 12, 2026" for an ISO date — used in measure notes. */
function longDate(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
}

/**
 * The full measure list. The historical measures carry their real absolute
 * dates; the Section 122 pair is anchored to seed day via `day` so the
 * demo's on-the-water mechanics stay live on any run date.
 */
export function buildMeasureSeed(day: DayFn): MeasureSeed[] {
  // Section 122 anchors, relative to seed day:
  //   sail cutoff          = day(-10)  (laden on/after this date -> surcharge)
  //   entry grace deadline = day(+7)   (pre-cutoff sailings entered by this
  //                                     date owe nothing)
  const cutoff = day(-10);
  const lastPreCutoffSail = day(-11); // cutoff − 1
  const graceDeadline = day(7);
  const postGrace = day(8); // graceDeadline + 1
  const s122Notes =
    "10% balance-of-payments surcharge on all imports. Goods loaded onto a " +
    `vessel before ${longDate(cutoff)} are exempt if entered for consumption ` +
    `on or before ${longDate(graceDeadline)}.`;
  const s122Ch99 = [
    {
      code: "9903.03.01",
      description: "Articles subject to the Section 122 import surcharge (10%)",
      rate: 0.1,
      exemption: false,
    },
    {
      code: "9903.03.02",
      description:
        "Articles exempt from the Section 122 surcharge (in-transit " +
        `exception: loaded onto a vessel before ${longDate(cutoff)} and ` +
        `entered for consumption on or before ${longDate(graceDeadline)})`,
      rate: 0,
      exemption: true,
    },
  ];

  return [
    {
      name: "Section 301 List 1 — China",
      authority: "section_301",
      scope: "hts_list",
      countries: ["CN"],
      effectiveDate: "2018-07-06",
      endDate: null,
      inLieuOfBaseDuty: false,
      notes: "Machinery and electronics, 25% ad valorem.",
      ch99: [
        {
          code: "9903.88.01",
          description: "Articles of China subject to Section 301 List 1 (25%)",
          rate: 0.25,
          exemption: false,
        },
      ],
      prefixes: ["8501", "8504", "8531"],
    },
    {
      name: "Section 301 List 3 — China",
      authority: "section_301",
      scope: "hts_list",
      countries: ["CN"],
      effectiveDate: "2018-09-24",
      endDate: null,
      inLieuOfBaseDuty: false,
      notes: "Broad goods coverage, 25% ad valorem since May 2019.",
      ch99: [
        {
          code: "9903.88.03",
          description: "Articles of China subject to Section 301 List 3 (25%)",
          rate: 0.25,
          exemption: false,
        },
        {
          code: "9903.88.67",
          description:
            "Exclusion: articles of China excluded from Section 301 List 3",
          rate: 0,
          exemption: true,
        },
      ],
      prefixes: ["8507", "7315", "7318"],
    },
    {
      name: "Section 301 List 4A — China",
      authority: "section_301",
      scope: "hts_list",
      countries: ["CN"],
      effectiveDate: "2020-02-14",
      endDate: null,
      inLieuOfBaseDuty: false,
      notes: "Consumer goods, 7.5% ad valorem.",
      ch99: [
        {
          code: "9903.88.15",
          description: "Articles of China subject to Section 301 List 4A (7.5%)",
          rate: 0.075,
          exemption: false,
        },
      ],
      prefixes: ["8714", "8512", "4011", "4013"],
    },
    {
      name: "IEEPA Reciprocal Tariff — baseline",
      authority: "reciprocal",
      scope: "all_products",
      countries: null,
      effectiveDate: "2025-04-05",
      endDate: null,
      inLieuOfBaseDuty: false,
      notes: "10% baseline on all imports regardless of HTS.",
      ch99: [
        {
          code: "9903.01.25",
          description: "Articles subject to the IEEPA reciprocal tariff (10%)",
          rate: 0.1,
          exemption: false,
        },
      ],
      prefixes: [],
    },
    {
      name: "Section 232 Aluminum — derivative articles",
      authority: "section_232_aluminum",
      scope: "hts_list",
      countries: null,
      effectiveDate: "2025-03-12",
      endDate: null,
      inLieuOfBaseDuty: false,
      notes: "Aluminum derivative articles (incl. alloy bicycle frames), 25%.",
      ch99: [
        {
          code: "9903.85.08",
          description:
            "Derivative aluminum articles subject to Section 232 (25%)",
          rate: 0.25,
          exemption: false,
        },
      ],
      prefixes: ["871491"],
    },
    // Section 122 surcharge, modeled as two sail-tiled rows sharing one
    // Chapter 99 code — re-anchored to seed day so the demo never goes
    // stale. The savings clause — goods laden before the day(-10) cutoff
    // owe nothing if entered by the day(+7) grace deadline — is the gap the
    // two windows leave open:
    //   sailed >= day(-10)                       -> row 1 (whenever entered)
    //   sailed <= day(-11), entered >= day(+8)   -> row 2 (grace missed)
    //   sailed <= day(-11), entered <= day(+7)   -> neither (savings clause)
    // The on-the-water demo: seed shipment SHP-1008 sailed day(-13) —
    // before the cutoff — with ETA day(+4), inside the grace window.
    {
      name: "Section 122 Import Surcharge",
      authority: "section_122",
      scope: "all_products",
      countries: null,
      effectiveDate: cutoff,
      endDate: null,
      sailedOnOrAfter: cutoff,
      inLieuOfBaseDuty: false,
      notes: s122Notes,
      ch99: s122Ch99,
      prefixes: [],
    },
    {
      name: "Section 122 Import Surcharge — pre-cutoff sailings past grace",
      authority: "section_122",
      scope: "all_products",
      countries: null,
      effectiveDate: postGrace,
      endDate: null,
      sailedOnOrBefore: lastPreCutoffSail,
      inLieuOfBaseDuty: false,
      notes:
        `The same 10% surcharge for goods laden before the ${longDate(cutoff)} ` +
        `cutoff that missed the ${longDate(graceDeadline)} entry grace deadline.`,
      ch99: s122Ch99,
      prefixes: [],
    },
  ];
}

export type StackingSeed = {
  winnerAuthority: MeasureAuthorityValue;
  loserAuthority: MeasureAuthorityValue;
  reason: string;
  effectiveDate: string;
  endDate: string | null;
  sourceRef: string;
};

export const STACKING_SEED: StackingSeed[] = [
  {
    winnerAuthority: "section_232_aluminum",
    loserAuthority: "reciprocal",
    reason:
      "Articles subject to Section 232 aluminum duties are not subject to the IEEPA reciprocal tariff (E.O. 14257 §3(b)).",
    effectiveDate: "2025-04-05",
    endDate: null,
    sourceRef: "E.O. 14257, 90 FR 15041",
  },
  {
    winnerAuthority: "section_232_steel",
    loserAuthority: "reciprocal",
    reason:
      "Articles subject to Section 232 steel duties are not subject to the IEEPA reciprocal tariff (E.O. 14257 §3(b)).",
    effectiveDate: "2025-04-05",
    endDate: null,
    sourceRef: "E.O. 14257, 90 FR 15041",
  },
];

/**
 * Build ReferenceData straight from this module, no DB involved. Used by
 * calculator tests and the stub processor; reference.ts builds the same
 * shape from the database. Takes the same day() anchor as buildMeasureSeed
 * so both views of the Section 122 pair agree.
 */
export function buildSeedReferenceData(day: DayFn): ReferenceData {
  const htsByDigits = new Map<string, HtsRef>(
    HTS_SEED.map((h) => {
      const codeDigits = normalizeHts(h.code);
      return [
        codeDigits,
        {
          code: h.code,
          codeDigits,
          description: h.description,
          chapter: Number(codeDigits.slice(0, 2)),
          rateType: h.rateType,
          rate: h.rate,
          exemption: false,
          tradeMeasureId: null,
        },
      ];
    }),
  );

  const measures: MeasureRef[] = [];
  for (const seed of buildMeasureSeed(day)) {
    const measureId = `seed:${seed.name}`;
    const exclusionDigits = seed.ch99
      .filter((c) => c.exemption)
      .map((c) => normalizeHts(c.code));

    for (const c of seed.ch99) {
      const codeDigits = normalizeHts(c.code);
      htsByDigits.set(codeDigits, {
        code: c.code,
        codeDigits,
        description: c.description,
        chapter: 99,
        rateType: "ad_valorem",
        rate: c.rate,
        exemption: c.exemption,
        tradeMeasureId: measureId,
      });
      if (c.exemption) continue;
      measures.push({
        id: measureId,
        name: seed.name,
        authority: seed.authority,
        scope: seed.scope,
        countries: seed.countries,
        effectiveDate: seed.effectiveDate,
        endDate: seed.endDate,
        sailedOnOrAfter: seed.sailedOnOrAfter ?? null,
        sailedOnOrBefore: seed.sailedOnOrBefore ?? null,
        inLieuOfBaseDuty: seed.inLieuOfBaseDuty,
        ch99Code: c.code,
        ch99Digits: codeDigits,
        rate: c.rate,
        exclusionDigits,
        prefixes: seed.prefixes,
      });
    }
  }

  const stackingRules: StackingRuleRef[] = STACKING_SEED.map((seed, i) => ({
    seed,
    i,
  }))
    .sort(
      (a, b) =>
        a.seed.effectiveDate.localeCompare(b.seed.effectiveDate) || a.i - b.i,
    )
    .map(({ seed }) => ({
      winnerAuthority: seed.winnerAuthority,
      loserAuthority: seed.loserAuthority,
      reason: seed.reason,
      effectiveDate: seed.effectiveDate,
      endDate: seed.endDate,
    }));

  return { htsByDigits, measures, stackingRules };
}
