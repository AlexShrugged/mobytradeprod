import { describe, expect, it } from "vitest";

import { resolveRegulatoryParams } from "./regulatory-params";

describe("resolveRegulatoryParams", () => {
  it("resolves an FY2025 date to the FY2025 window", () => {
    const p = resolveRegulatoryParams("2025-03-15");
    expect(p?.fiscalYear).toBe(2025);
    expect(p?.mpf.minCents).toBe(3271);
    expect(p?.mpf.maxCents).toBe(63462);
  });

  it("switches windows exactly at October 1", () => {
    expect(resolveRegulatoryParams("2025-09-30")?.fiscalYear).toBe(2025);
    expect(resolveRegulatoryParams("2025-10-01")?.fiscalYear).toBe(2026);
  });

  it("resolves an FY2026 date to the FY2026 figures", () => {
    const p = resolveRegulatoryParams("2026-08-13");
    expect(p?.fiscalYear).toBe(2026);
    expect(p?.mpf.minCents).toBe(3358);
    expect(p?.mpf.maxCents).toBe(65150);
  });

  it("carries a Federal Register citation", () => {
    expect(resolveRegulatoryParams("2026-01-01")?.source).toContain("FR");
  });

  it("returns null before the earliest known window", () => {
    expect(resolveRegulatoryParams("2023-06-01")).toBeNull();
  });

  it("keeps money as integer cents", () => {
    const p = resolveRegulatoryParams("2026-01-01");
    expect(Number.isInteger(p?.mpf.minCents)).toBe(true);
    expect(Number.isInteger(p?.mpf.maxCents)).toBe(true);
  });
});
