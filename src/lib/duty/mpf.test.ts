import { describe, expect, it } from "vitest";

import { computeExpectedMpf, isMpfExemptClaim } from "./mpf";

const line = (enteredCents: number, spi: string | null = null, lineNumber = 1) => ({
  lineNumber,
  enteredCents,
  spi,
});

describe("computeExpectedMpf", () => {
  it("floors a small entry at the fiscal year's per-entry minimum", () => {
    // 231-7385625-0: $4,386 × 0.3464% = $15.19, Block 43 printed $33.58.
    const e = computeExpectedMpf("2026-09-21", [line(4386_00)]);
    expect(e?.params.fiscalYear).toBe(2026);
    expect(e?.adValoremCents).toBe(1519);
    expect(e?.expectedCents).toBe(3358);
    expect(e?.bound).toBe("minimum");
  });

  it("caps a large entry at the per-entry maximum", () => {
    // 231-7383835-7: $280,587 × 0.3464% = $971.95, Block 43 printed $651.50.
    const e = computeExpectedMpf("2026-09-06", [line(280587_00)]);
    expect(e?.adValoremCents).toBe(97195);
    expect(e?.expectedCents).toBe(65150);
    expect(e?.bound).toBe("maximum");
  });

  it("charges the plain ad valorem inside the window", () => {
    const e = computeExpectedMpf("2026-09-06", [line(50000_00)]);
    expect(e?.expectedCents).toBe(17320);
    expect(e?.bound).toBe("ad_valorem");
  });

  it("uses the fiscal year in force on the entry date", () => {
    expect(computeExpectedMpf("2025-09-30", [line(100_00)])?.expectedCents).toBe(3271);
    expect(computeExpectedMpf("2025-10-01", [line(100_00)])?.expectedCents).toBe(3358);
  });

  it("returns null before the earliest known fiscal year", () => {
    expect(computeExpectedMpf("2024-06-01", [line(100_00)])).toBeNull();
  });

  it("expects no fee when every line claims an MPF-exempt preference", () => {
    const e = computeExpectedMpf("2026-09-05", [
      line(473234_00, "KR", 1),
      line(1000_00, "kr ", 2),
    ]);
    expect(e?.expectedCents).toBe(0);
    expect(e?.bound).toBe("exempt");
    expect(e?.exemptLineNumbers).toEqual([1, 2]);
  });

  it("assesses a mixed entry on the non-exempt lines only", () => {
    const e = computeExpectedMpf("2026-09-05", [
      line(100000_00, "KR", 1),
      line(20000_00, null, 2),
    ]);
    expect(e?.basisCents).toBe(20000_00);
    expect(e?.expectedCents).toBe(6928);
    expect(e?.exemptLineNumbers).toEqual([1]);
  });

  it("treats general GSP and AGOA claims as still owing the fee", () => {
    expect(isMpfExemptClaim("A")).toBe(false);
    expect(isMpfExemptClaim("D")).toBe(false);
    expect(isMpfExemptClaim("A+")).toBe(true);
    expect(isMpfExemptClaim(null)).toBe(false);
    expect(isMpfExemptClaim("")).toBe(false);
  });
});
