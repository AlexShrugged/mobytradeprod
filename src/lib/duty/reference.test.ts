import { describe, expect, it } from "vitest";

import {
  buildReferenceData,
  resolveSpecialText,
  type HtsCodeRow,
  type StackingRuleRow,
  type TradeMeasureRow,
} from "./reference";

// The scoped loader (loadReferenceDataScoped) is "buildReferenceData over a
// row subset" by construction; these tests pin the pure assembly so both
// loaders share one verified behavior: feeding in fewer base rows must
// change nothing about the rows that ARE fed in.

const NOW = new Date("2026-01-01T00:00:00Z");

let idCounter = 0;
// uuidv7-like: lexicographically increasing, so insertion order == id order.
const nextId = () => `00000000-0000-0000-0000-${String(++idCounter).padStart(12, "0")}`;

function htsRow(over: Partial<HtsCodeRow> & Pick<HtsCodeRow, "code" | "codeDigits">): HtsCodeRow {
  return {
    id: nextId(),
    description: `Row ${over.code}`,
    chapter: Number(over.codeDigits.slice(0, 2)),
    rateType: "ad_valorem",
    rate: "0.05",
    col1General: "5%",
    col1Special: null,
    col2Rate: null,
    unitOfQuantity: null,
    indent: null,
    parentDigits: null,
    rateInheritedFrom: null,
    release: "TEST",
    validFrom: "2025-01-01",
    validTo: null,
    tradeMeasureId: null,
    exemption: false,
    carveoutTriggerProgram: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  };
}

function measureRow(
  over: Partial<TradeMeasureRow> & Pick<TradeMeasureRow, "name" | "effectiveDate">,
): TradeMeasureRow {
  return {
    id: nextId(),
    authority: "section_301",
    program: null,
    scope: "hts_list",
    countries: ["CN"],
    countriesExcluded: null,
    endDate: null,
    sailedOnOrAfter: null,
    sailedOnOrBefore: null,
    predecessorId: null,
    inLieuOfBaseDuty: false,
    col1RateBelow: null,
    notes: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  };
}

function stackingRow(
  over: Partial<StackingRuleRow> &
    Pick<StackingRuleRow, "winnerAuthority" | "loserAuthority" | "effectiveDate">,
): StackingRuleRow {
  return {
    id: nextId(),
    reason: "Winner beats loser.",
    endDate: null,
    sourceRef: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  };
}

function fixture() {
  const m301 = measureRow({ name: "301 List 1", effectiveDate: "2018-07-06" });
  const rows = {
    measures: [m301],
    hts: [
      // Two base codes, one with a closed historical window.
      htsRow({ code: "8501.10.40", codeDigits: "85011040" }),
      htsRow({
        code: "8507.60.00",
        codeDigits: "85076000",
        rate: "0.02",
        validFrom: "2024-01-01",
        validTo: "2025-06-30",
      }),
      htsRow({
        code: "8507.60.00",
        codeDigits: "85076000",
        rate: "0.034",
        validFrom: "2025-07-01",
        validTo: null,
      }),
      // The measure's Chapter 99 line + an exemption line under it.
      htsRow({
        code: "9903.88.01",
        codeDigits: "99038801",
        rate: "0.25",
        validFrom: null,
        tradeMeasureId: m301.id,
      }),
      htsRow({
        code: "9903.88.67",
        codeDigits: "99038867",
        rate: null,
        validFrom: null,
        tradeMeasureId: m301.id,
        exemption: true,
      }),
    ],
    prefixes: [{ tradeMeasureId: m301.id, htsPrefix: "8501" }],
    stacking: [
      stackingRow({
        winnerAuthority: "section_232_aluminum",
        loserAuthority: "reciprocal",
        effectiveDate: "2025-04-05",
      }),
    ],
  };
  return rows;
}

describe("buildReferenceData", () => {
  it("assembles the same entries from a digit-scoped row subset as from the full set", () => {
    const f = fixture();
    const full = buildReferenceData(f.hts, f.measures, f.prefixes, f.stacking);

    // Simulate the scoped loader for an org that only references 85076000:
    // all Ch99 rows + that code's base windows.
    const scopedRows = f.hts.filter(
      (h) => h.tradeMeasureId !== null || h.codeDigits === "85076000",
    );
    const scoped = buildReferenceData(scopedRows, f.measures, f.prefixes, f.stacking);

    expect(scoped.htsByDigits.get("85076000")).toEqual(
      full.htsByDigits.get("85076000"),
    );
    expect(scoped.baseWindowsByDigits?.get("85076000")).toEqual(
      full.baseWindowsByDigits?.get("85076000"),
    );
    expect(scoped.measures).toEqual(full.measures);
    expect(scoped.stackingRules).toEqual(full.stackingRules);
    expect(scoped.exemptionsByDigits).toEqual(full.exemptionsByDigits);
    // The unrequested digits simply read as "not in reference".
    expect(scoped.htsByDigits.has("85011040")).toBe(false);
    expect(scoped.baseWindowsByDigits?.has("85011040")).toBe(false);
  });

  it("keeps the full Chapter 99 reference regardless of base scope", () => {
    const f = fixture();
    const noBase = buildReferenceData(
      f.hts.filter((h) => h.tradeMeasureId !== null),
      f.measures,
      f.prefixes,
      f.stacking,
    );
    expect(noBase.measures).toHaveLength(1);
    expect(noBase.measures[0]).toMatchObject({
      ch99Digits: "99038801",
      rate: 0.25,
      exclusionDigits: ["99038867"],
      prefixes: ["8501"],
    });
    expect(noBase.exemptionsByDigits?.get("99038867")).toEqual([
      { effectiveDate: "2018-07-06", endDate: null },
    ]);
  });

  it("orders base windows newest-first and keeps only the current window in htsByDigits", () => {
    const f = fixture();
    const ref = buildReferenceData(f.hts, f.measures, f.prefixes, f.stacking);
    const windows = ref.baseWindowsByDigits?.get("85076000");
    expect(windows?.map((w) => w.validFrom)).toEqual([
      "2025-07-01",
      "2024-01-01",
    ]);
    expect(ref.htsByDigits.get("85076000")).toMatchObject({
      rate: 0.034,
      validTo: null,
    });
  });

  it("lets the latest measure window win htsByDigits when Ch99 digits repeat", () => {
    const early = measureRow({ name: "IEEPA v1", effectiveDate: "2025-02-01" });
    const late = measureRow({
      name: "IEEPA v2",
      effectiveDate: "2025-06-01",
      predecessorId: early.id,
    });
    const rows = [
      htsRow({
        code: "9903.01.25",
        codeDigits: "99030125",
        rate: "0.10",
        validFrom: null,
        tradeMeasureId: early.id,
      }),
      htsRow({
        code: "9903.01.25",
        codeDigits: "99030125",
        rate: "0.20",
        validFrom: null,
        tradeMeasureId: late.id,
      }),
    ];
    const ref = buildReferenceData(rows, [early, late], [], []);
    expect(ref.htsByDigits.get("99030125")?.rate).toBe(0.2);
    // Both windows still exist as measures — the map is display-only.
    expect(ref.measures.map((m) => m.rate).sort()).toEqual([0.1, 0.2]);
  });
});

describe("resolveSpecialText — statistical suffixes inherit the special-rates text", () => {
  it("answers an SPI claim on a 10-digit suffix with its rate ancestor's text, window-aware", () => {
    // The subheading prints the rates once; the suffix's own cells are blank
    // (null in rows synced before the ETL inherited the text). Two parent
    // windows: the suffix's window picks the parent window covering it.
    const parentOld = htsRow({
      code: "8301.20.00",
      codeDigits: "83012000",
      col1Special: "Free (A*,AU,BH,S)",
      validFrom: "2025-01-01",
      validTo: "2026-08-02",
    });
    const parentNew = htsRow({
      code: "8301.20.00",
      codeDigits: "83012000",
      col1Special: "Free (A*,AU,BH,S,SG)",
      validFrom: "2026-08-03",
      validTo: null,
    });
    const suffixOld = htsRow({
      code: "8301.20.00.60",
      codeDigits: "8301200060",
      col1Special: null,
      rateInheritedFrom: "83012000",
      validFrom: "2025-01-01",
      validTo: "2026-08-02",
    });
    const suffixNew = htsRow({
      code: "8301.20.00.60",
      codeDigits: "8301200060",
      col1Special: null,
      rateInheritedFrom: "83012000",
      validFrom: "2026-08-03",
      validTo: null,
    });
    const ref = buildReferenceData(
      [parentOld, parentNew, suffixOld, suffixNew],
      [],
      [],
      [],
    );
    expect(ref.htsByDigits.get("8301200060")?.col1Special).toBe(
      "Free (A*,AU,BH,S,SG)",
    );
    // Newest window first; each carries its own parent window's text.
    expect(
      (ref.baseWindowsByDigits?.get("8301200060") ?? []).map((w) => w.col1Special),
    ).toEqual(["Free (A*,AU,BH,S,SG)", "Free (A*,AU,BH,S)"]);
    // The parent's own text is untouched.
    expect(ref.htsByDigits.get("83012000")?.col1Special).toBe(
      "Free (A*,AU,BH,S,SG)",
    );
  });

  it("chains through an inheriting ancestor and stays null when no ancestor prints special rates", () => {
    const heading = htsRow({
      code: "0101.29.00",
      codeDigits: "01012900",
      col1Special: "Free (A+,AU,BH)",
    });
    const mid = htsRow({
      code: "0101.29.00.10",
      codeDigits: "0101290010",
      col1Special: null,
      rateInheritedFrom: "01012900",
    });
    const leaf = htsRow({
      code: "0101.29.00.10.5",
      codeDigits: "010129001050",
      col1Special: null,
      rateInheritedFrom: "0101290010",
    });
    const bare = htsRow({
      code: "0101.21.00",
      codeDigits: "01012100",
      col1Special: null,
    });
    const bareSuffix = htsRow({
      code: "0101.21.00.10",
      codeDigits: "0101210010",
      col1Special: null,
      rateInheritedFrom: "01012100",
    });
    const orphan = htsRow({
      code: "0101.30.00.00",
      codeDigits: "0101300000",
      col1Special: null,
      rateInheritedFrom: "01013000", // not loaded
    });
    const rows = [heading, mid, leaf, bare, bareSuffix, orphan];
    const byDigits = new Map<string, typeof rows>();
    for (const r of rows) byDigits.set(r.codeDigits, [...(byDigits.get(r.codeDigits) ?? []), r]);
    expect(resolveSpecialText(leaf, byDigits)).toBe("Free (A+,AU,BH)");
    expect(resolveSpecialText(mid, byDigits)).toBe("Free (A+,AU,BH)");
    expect(resolveSpecialText(heading, byDigits)).toBe("Free (A+,AU,BH)");
    expect(resolveSpecialText(bareSuffix, byDigits)).toBeNull();
    expect(resolveSpecialText(orphan, byDigits)).toBeNull();
  });
});
