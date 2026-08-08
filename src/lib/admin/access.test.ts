import { describe, expect, it } from "vitest";

import { resolveAdminAccess, secretMatches } from "./access";

describe("secretMatches", () => {
  it("accepts the exact secret", () => {
    expect(secretMatches("s3cret", "s3cret")).toBe(true);
  });
  it("rejects a wrong secret", () => {
    expect(secretMatches("nope", "s3cret")).toBe(false);
  });
  it("rejects length mismatches without throwing", () => {
    expect(secretMatches("s3cret-but-longer", "s3cret")).toBe(false);
  });
  it("rejects missing values", () => {
    expect(secretMatches(undefined, "s3cret")).toBe(false);
    expect(secretMatches(null, "s3cret")).toBe(false);
    expect(secretMatches("", "s3cret")).toBe(false);
  });
});

describe("resolveAdminAccess", () => {
  it("is open when no secret is configured (dev posture)", () => {
    expect(resolveAdminAccess(undefined, undefined)).toBe(true);
    expect(resolveAdminAccess(undefined, "anything")).toBe(true);
  });
  it("requires the matching cookie once configured", () => {
    expect(resolveAdminAccess("s3cret", "s3cret")).toBe(true);
    expect(resolveAdminAccess("s3cret", "wrong")).toBe(false);
    expect(resolveAdminAccess("s3cret", undefined)).toBe(false);
  });
});
