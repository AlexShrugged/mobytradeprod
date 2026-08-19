import { describe, expect, it } from "vitest";

import { homeForDocument, MISC_HOME } from "./document-homing";

const ENTRY = "entry-1";

describe("homeForDocument", () => {
  it("homes the entry-creating 7501 under the entry", () => {
    expect(
      homeForDocument(
        "port_entry",
        [
          { entityType: "entry", entityId: ENTRY, created: true },
          { entityType: "purchase_order", entityId: "po-1", created: true },
        ],
        ENTRY,
      ),
    ).toBe(`entry:${ENTRY}`);
  });

  it("homes a non-creating 7501 under the entry, not its PO", () => {
    // The ASC incident: a misclassified release created the entry first, so
    // the real 7501's entry link had created: false and the old homing
    // exiled it to the Purchase orders group.
    expect(
      homeForDocument(
        "port_entry",
        [
          { entityType: "entry", entityId: ENTRY, created: false },
          { entityType: "shipment", entityId: "shp-1", created: false },
          { entityType: "purchase_order", entityId: "po-1", created: false },
        ],
        ENTRY,
      ),
    ).toBe(`entry:${ENTRY}`);
  });

  it("homes a cargo release linked to this entry under the entry", () => {
    expect(
      homeForDocument(
        "cargo_release",
        [{ entityType: "entry", entityId: ENTRY, created: false }],
        ENTRY,
      ),
    ).toBe(`entry:${ENTRY}`);
  });

  it("sends a sibling entry's 7501 to Miscellaneous", () => {
    // Linked here only through the shared PO/shipment — its own entry link
    // points elsewhere and isn't in this page's rows.
    expect(
      homeForDocument(
        "port_entry",
        [
          { entityType: "shipment", entityId: "shp-1", created: false },
          { entityType: "purchase_order", entityId: "po-1", created: false },
        ],
        ENTRY,
      ),
    ).toBe(MISC_HOME);
  });

  it("homes a BOL under its shipment even when it also created a PO stub", () => {
    expect(
      homeForDocument(
        "shipment",
        [
          { entityType: "purchase_order", entityId: "po-1", created: true },
          { entityType: "shipment", entityId: "shp-1", created: false },
        ],
        ENTRY,
      ),
    ).toBe("shipment:shp-1");
  });

  it("prefers the shipment a BOL created over one it references", () => {
    expect(
      homeForDocument(
        "shipment",
        [
          { entityType: "shipment", entityId: "shp-ref", created: false },
          { entityType: "shipment", entityId: "shp-own", created: true },
        ],
        ENTRY,
      ),
    ).toBe("shipment:shp-own");
  });

  it("homes a CI under its invoice", () => {
    expect(
      homeForDocument(
        "commercial_invoice",
        [
          { entityType: "purchase_order", entityId: "po-1", created: false },
          { entityType: "invoice", entityId: "inv-1", created: true },
          { entityType: "entry", entityId: ENTRY, created: false },
        ],
        ENTRY,
      ),
    ).toBe("invoice:inv-1");
  });

  it("sends another entry's CI to Miscellaneous, not the shared PO", () => {
    expect(
      homeForDocument(
        "commercial_invoice",
        [{ entityType: "purchase_order", entityId: "po-1", created: true }],
        ENTRY,
      ),
    ).toBe(MISC_HOME);
  });

  it("homes a packing list under the shipment it references", () => {
    expect(
      homeForDocument(
        "packing_list",
        [{ entityType: "shipment", entityId: "shp-1", created: false }],
        ENTRY,
      ),
    ).toBe("shipment:shp-1");
  });

  it("homes a refund report under the entry", () => {
    expect(
      homeForDocument(
        "refund_report",
        [{ entityType: "entry", entityId: ENTRY, created: false }],
        ENTRY,
      ),
    ).toBe(`entry:${ENTRY}`);
  });

  it("sends unclassed paperwork to Miscellaneous", () => {
    expect(
      homeForDocument(
        "other",
        [{ entityType: "purchase_order", entityId: "po-1", created: false }],
        ENTRY,
      ),
    ).toBe(MISC_HOME);
  });
});
