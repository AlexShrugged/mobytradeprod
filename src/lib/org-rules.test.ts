// The two change-detection gates the org-rules routes decide side effects
// with: sameSuppressionSemantics gates the synchronous audit sweep,
// sameAnalystSemantics the (costlier) re-analysis queue. The analyst gate
// is strictly wider — everything that re-sweeps also re-analyzes, but text
// edits and guidance toggles re-analyze without sweeping.

import { describe, expect, it } from "vitest";

import { sameAnalystSemantics, sameSuppressionSemantics } from "./org-rules";

const rule = (over: {
  enabled?: boolean;
  text?: string;
  suppression?: unknown;
}) => ({
  enabled: true,
  text: "Ignore Korea origin variances",
  suppression: null as unknown,
  ...over,
});

const spec = {
  alertTypes: ["missing_measure"],
  supplierName: null,
  countryOfOrigin: "KR",
  htsPrefix: null,
};

describe("sameAnalystSemantics", () => {
  it("text edits on an enabled rule change analyst semantics (but not suppression semantics)", () => {
    const before = rule({ suppression: spec });
    const after = rule({ suppression: spec, text: "Different wording" });
    expect(sameAnalystSemantics(before, after)).toBe(false);
    expect(sameSuppressionSemantics(before, after)).toBe(true);
  });

  it("guidance enable/disable flips change analyst semantics only", () => {
    const before = rule({ enabled: true });
    const after = rule({ enabled: false });
    expect(sameAnalystSemantics(before, after)).toBe(false);
    expect(sameSuppressionSemantics(before, after)).toBe(true);
  });

  it("edits to a disabled rule change nothing for either layer", () => {
    const before = rule({ enabled: false, suppression: spec });
    const after = rule({
      enabled: false,
      suppression: null,
      text: "Rewritten",
    });
    expect(sameAnalystSemantics(before, after)).toBe(true);
    expect(sameSuppressionSemantics(before, after)).toBe(true);
  });

  it("spec add/remove/edit changes both layers", () => {
    const guidance = rule({});
    const suppressing = rule({ suppression: spec });
    expect(sameAnalystSemantics(guidance, suppressing)).toBe(false);
    expect(sameSuppressionSemantics(guidance, suppressing)).toBe(false);

    const narrowed = rule({ suppression: { ...spec, htsPrefix: "8481" } });
    expect(sameAnalystSemantics(suppressing, narrowed)).toBe(false);
    expect(sameSuppressionSemantics(suppressing, narrowed)).toBe(false);
  });

  it("spec key order does not matter", () => {
    const reordered = {
      htsPrefix: null,
      countryOfOrigin: "KR",
      alertTypes: ["missing_measure"],
      supplierName: null,
    };
    expect(
      sameAnalystSemantics(
        rule({ suppression: spec }),
        rule({ suppression: reordered }),
      ),
    ).toBe(true);
  });

  it("no-op writes are no-ops", () => {
    const r = rule({ suppression: spec });
    expect(sameAnalystSemantics(r, { ...r })).toBe(true);
    expect(sameSuppressionSemantics(r, { ...r })).toBe(true);
  });
});
