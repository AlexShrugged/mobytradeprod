import { describe, expect, it } from "vitest";

import { checkBaseReleaseSanity, MIN_PREPARED_ROWS } from "./base-guard";
import type { BaseDiff, CurrentBaseWindow, PreparedBaseRow } from "./types";

const row = (digits: string): PreparedBaseRow => ({
  code: digits,
  codeDigits: digits,
  chapter: 85,
  description: "x",
  indent: 0,
  parentDigits: null,
  rateType: "ad_valorem",
  rate: 0.05,
  col1General: "5%",
  col1Special: null,
  col2Rate: null,
  unitOfQuantity: null,
  rateInheritedFrom: null,
});

const win = (digits: string): CurrentBaseWindow => ({
  codeDigits: digits,
  code: digits,
  description: "x",
  rate: 0.05,
  validFrom: "2025-01-01",
  release: "2026HTSRev1",
});

const diffOf = (over: Partial<BaseDiff>): BaseDiff => ({
  added: [],
  changed: [],
  removed: [],
  unchanged: 0,
  ...over,
});

describe("checkBaseReleaseSanity", () => {
  it("trips the absolute minimum on a tiny parse regardless of current state", () => {
    const verdict = checkBaseReleaseSanity(diffOf({}), 120, 30_000);
    expect(verdict.ok).toBe(false);
    expect(verdict.reasons[0]).toMatch(/truncated fetch/);
  });

  it("lets the 23-row seed bootstrap pass everything but the absolute minimum", () => {
    // First certified release against the demo seed: replaces nearly all of
    // a 23-row reference. Relative checks must not fire.
    const verdict = checkBaseReleaseSanity(
      diffOf({ added: Array.from({ length: 29_000 }, (_, i) => row(String(i))) }),
      30_000,
      23,
    );
    expect(verdict).toEqual({ ok: true, reasons: [] });
  });

  it("trips on removals above 10% of an established schedule", () => {
    const removed = Array.from({ length: 3_500 }, (_, i) => win(String(i)));
    const verdict = checkBaseReleaseSanity(
      diffOf({ removed, unchanged: 26_500 }),
      MIN_PREPARED_ROWS,
      30_000,
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.reasons.some((r) => r.includes("would be removed"))).toBe(true);
  });

  it("trips on a shrunken release against an established schedule", () => {
    const verdict = checkBaseReleaseSanity(diffOf({}), 20_000, 30_000);
    expect(verdict.ok).toBe(false);
    expect(verdict.reasons.some((r) => r.includes("shrunken"))).toBe(true);
  });

  it("trips when more than half the schedule changes at once", () => {
    const changed = Array.from({ length: 16_000 }, (_, i) => ({
      row: row(String(i)),
      current: win(String(i)),
    }));
    const verdict = checkBaseReleaseSanity(
      diffOf({ changed, unchanged: 14_000 }),
      30_000,
      30_000,
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.reasons.some((r) => r.includes("rate-parse regression"))).toBe(
      true,
    );
  });

  it("passes an ordinary revision", () => {
    const verdict = checkBaseReleaseSanity(
      diffOf({
        added: [row("1")],
        changed: [{ row: row("2"), current: win("2") }],
        removed: [win("3")],
        unchanged: 29_000,
      }),
      29_003,
      29_002,
    );
    expect(verdict).toEqual({ ok: true, reasons: [] });
  });
});
