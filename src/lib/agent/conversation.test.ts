import { describe, expect, it } from "vitest";

import { deriveTitle, lockIsStale, sanitizeTitle } from "./conversation";

describe("deriveTitle", () => {
  it("uses the message verbatim when short", () => {
    expect(deriveTitle("Biggest open variances?")).toBe(
      "Biggest open variances?",
    );
  });

  it("collapses whitespace and trims", () => {
    expect(deriveTitle("  what\n  about   entry   E-100  ")).toBe(
      "what about entry E-100",
    );
  });

  it("cuts at a word boundary near 60 chars", () => {
    const input =
      "please walk through every broker packet from July and check the 301 exclusions";
    const title = deriveTitle(input);
    expect(title.length).toBeLessThanOrEqual(60);
    expect(title.endsWith(" ")).toBe(false);
    // Prefix of the input, ending exactly at a word boundary.
    expect(input.startsWith(title)).toBe(true);
    expect(input[title.length]).toBe(" ");
  });

  it("falls back for empty input", () => {
    expect(deriveTitle("   ")).toBe("New conversation");
  });
});

describe("sanitizeTitle", () => {
  it("strips wrapping quotes and a trailing period", () => {
    expect(sanitizeTitle('  "Open variance review."  ')).toBe(
      "Open variance review",
    );
    expect(sanitizeTitle("“Entry E-100 audit”")).toBe("Entry E-100 audit");
  });

  it("collapses internal whitespace", () => {
    expect(sanitizeTitle("Section 301\n  exposure   check")).toBe(
      "Section 301 exposure check",
    );
  });

  it("caps at the deriveTitle word boundary", () => {
    const long =
      "please walk through every broker packet from July and check the 301 exclusions";
    expect(sanitizeTitle(long)).toBe(deriveTitle(long));
  });

  it("returns null when nothing usable remains", () => {
    expect(sanitizeTitle("")).toBeNull();
    expect(sanitizeTitle('  "." ')).toBeNull();
  });
});

describe("lockIsStale", () => {
  const now = new Date("2026-08-18T12:00:00Z");
  it("treats no lock as stale (claimable)", () => {
    expect(lockIsStale(null, now, 1000)).toBe(true);
  });
  it("holds a fresh lock", () => {
    expect(lockIsStale(new Date(now.getTime() - 500), now, 1000)).toBe(false);
  });
  it("releases past deadline + grace", () => {
    expect(
      lockIsStale(new Date(now.getTime() - 1000 - 60_000 - 1), now, 1000),
    ).toBe(true);
  });
});
