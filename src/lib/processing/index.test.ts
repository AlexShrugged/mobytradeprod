import { describe, expect, it } from "vitest";

import { inferDocType } from "./index";

describe("inferDocType", () => {
  it("keeps broker invoices out of the commercial_invoice hint", () => {
    // The hint is fed into the classification prompt as a provisional
    // label — a broker's bill must not arrive pre-labeled as an invoice.
    expect(inferDocType("expeditors_broker_invoice.pdf")).toBe("other");
    expect(inferDocType("Broker Invoice 2026-08.pdf")).toBe("other");
  });

  it("still hints supplier invoices as commercial_invoice", () => {
    expect(inferDocType("supplier_commercial_invoice.pdf")).toBe(
      "commercial_invoice",
    );
  });
});
