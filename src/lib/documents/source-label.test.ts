import { describe, expect, it } from "vitest";

import { documentSourceLabel } from "./source-label";

describe("documentSourceLabel", () => {
  it("names the channel for automated sources, whoever ran them", () => {
    expect(documentSourceLabel({ sourceKind: "sftp", uploadedBy: null })).toBe(
      "SFTP",
    );
    expect(
      documentSourceLabel({ sourceKind: "email_inbox", uploadedBy: "Alex" }),
    ).toBe("Email");
    expect(documentSourceLabel({ sourceKind: "erp", uploadedBy: null })).toBe(
      "ERP",
    );
  });

  it("names the person for a native upload", () => {
    expect(
      documentSourceLabel({ sourceKind: "manual_upload", uploadedBy: "Alex" }),
    ).toBe("Alex");
    // A row whose channel was never recorded but whose uploader was.
    expect(documentSourceLabel({ sourceKind: null, uploadedBy: "Alex" })).toBe(
      "Alex",
    );
  });

  it("falls back to the channel label for a native upload with no person", () => {
    expect(
      documentSourceLabel({ sourceKind: "manual_upload", uploadedBy: null }),
    ).toBe("Manual");
    expect(
      documentSourceLabel({ sourceKind: "manual_upload", uploadedBy: "  " }),
    ).toBe("Manual");
  });

  it("is blank when neither channel nor person is known", () => {
    expect(documentSourceLabel({ sourceKind: null, uploadedBy: null })).toBe(
      null,
    );
  });
});
