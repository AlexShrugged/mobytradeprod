import { describe, expect, it } from "vitest";

import { isMutatingMethod, orgPinVerdict } from "./org-pin";

describe("orgPinVerdict", () => {
  const session = "org_A";

  it("accepts a pin that matches the session org on any method", () => {
    for (const method of ["GET", "POST", "PATCH", "DELETE", "put"]) {
      expect(
        orgPinVerdict({ method, sessionOrgId: session, pinnedOrgId: "org_A" }),
      ).toBe("ok");
    }
  });

  it("refuses a pin for another org on every method, reads included", () => {
    for (const method of ["GET", "HEAD", "POST", "PATCH", "DELETE"]) {
      expect(
        orgPinVerdict({ method, sessionOrgId: session, pinnedOrgId: "org_B" }),
      ).toBe("mismatch");
    }
  });

  it("refuses a mutation with no pin, tolerates a read with none", () => {
    for (const pinnedOrgId of [null, undefined, "", "   "]) {
      expect(
        orgPinVerdict({ method: "POST", sessionOrgId: session, pinnedOrgId }),
      ).toBe("missing");
      expect(
        orgPinVerdict({ method: "GET", sessionOrgId: session, pinnedOrgId }),
      ).toBe("ok");
    }
  });

  it("treats a session that lost its org as a mismatch for a pinned tab", () => {
    expect(
      orgPinVerdict({ method: "GET", sessionOrgId: null, pinnedOrgId: "org_A" }),
    ).toBe("mismatch");
  });

  it("ignores surrounding whitespace in the pin", () => {
    expect(
      orgPinVerdict({ method: "POST", sessionOrgId: session, pinnedOrgId: " org_A " }),
    ).toBe("ok");
  });
});

describe("isMutatingMethod", () => {
  it("names the four writing verbs, case-insensitively", () => {
    expect(["POST", "put", "Patch", "DELETE"].every(isMutatingMethod)).toBe(true);
    expect(["GET", "HEAD", "OPTIONS"].some(isMutatingMethod)).toBe(false);
  });
});
