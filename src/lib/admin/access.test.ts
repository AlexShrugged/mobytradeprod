import { describe, expect, it } from "vitest";

import { parseAllowlist, resolveAdminAccess } from "./access";

describe("parseAllowlist", () => {
  it("returns empty for unset or empty input", () => {
    expect(parseAllowlist(undefined)).toEqual([]);
    expect(parseAllowlist("")).toEqual([]);
  });
  it("splits on commas and trims whitespace", () => {
    expect(parseAllowlist("user_a, user_b ,user_c")).toEqual([
      "user_a",
      "user_b",
      "user_c",
    ]);
  });
  it("drops empty segments (trailing/doubled commas)", () => {
    expect(parseAllowlist("user_a,,user_b,")).toEqual(["user_a", "user_b"]);
    expect(parseAllowlist(" , ")).toEqual([]);
  });
});

describe("resolveAdminAccess", () => {
  it("is open when Clerk is disabled (local dev posture)", () => {
    expect(resolveAdminAccess([], null, false)).toBe(true);
    expect(resolveAdminAccess(["user_a"], null, false)).toBe(true);
  });
  it("rejects a signed-out caller when Clerk is enabled", () => {
    expect(resolveAdminAccess(["user_a"], null, true)).toBe(false);
  });
  it("rejects everyone on an empty allowlist when Clerk is enabled", () => {
    expect(resolveAdminAccess([], "user_a", true)).toBe(false);
  });
  it("admits exactly the allowlisted users when Clerk is enabled", () => {
    expect(resolveAdminAccess(["user_a", "user_b"], "user_a", true)).toBe(true);
    expect(resolveAdminAccess(["user_a", "user_b"], "user_z", true)).toBe(
      false,
    );
  });
});
