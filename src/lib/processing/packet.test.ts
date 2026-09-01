import { describe, expect, it } from "vitest";

import {
  childFileName,
  isEntryPacket,
  mapSplitToManifest,
  normalizeRole,
  orderPacketParts,
  pageRangeLabel,
  roleToDocType,
} from "./packet";
import { ProcessingError } from "./types";
import type { PacketPartExtraction } from "./types";

describe("normalizeRole", () => {
  it("maps the canonical section names", () => {
    expect(normalizeRole("CBP Form 7501 Entry Summary")).toBe(
      "entry_summary_7501",
    );
    expect(normalizeRole("Commercial Invoice")).toBe("commercial_invoice");
    expect(normalizeRole("Packing List")).toBe("packing_list");
    expect(normalizeRole("Bill of Lading")).toBe("transport_document");
    expect(normalizeRole("Certificate of Origin")).toBe(
      "certificate_of_origin",
    );
    expect(normalizeRole("HTS Code List")).toBe("hts_code_list");
    // The broker's line-to-part mapping sheet must NEVER route into the
    // 7501 pipeline: an authoritative port_entry extraction of it would
    // wholesale-replace the real entry's lines with tariff-heading noise.
    expect(normalizeRole("Entry Tariff Code Sheet")).toBe("hts_code_list");
  });

  it("maps cargo releases to their own role, never the 7501's", () => {
    expect(normalizeRole("Cargo Release")).toBe("cargo_release");
    expect(normalizeRole("CBP Form 3461")).toBe("cargo_release");
    expect(normalizeRole("Entry/Immediate Delivery")).toBe("cargo_release");
    expect(roleToDocType("cargo_release")).toBe("cargo_release");
    // The 7501 keeps its role — "entry summary" never matches the release
    // patterns.
    expect(normalizeRole("Entry Summary 7501")).toBe("entry_summary_7501");
  });

  it("matches assist sheets BEFORE the broad invoice pattern", () => {
    // The legacy lesson: assist sheets look columnar like invoices. A title
    // carrying both words must resolve to assist_sheet, never
    // commercial_invoice.
    expect(normalizeRole("Commercial Invoice Assist Sheet")).toBe(
      "assist_sheet",
    );
    expect(normalizeRole("Assist Sheet")).toBe("assist_sheet");
  });

  it("matches broker invoices BEFORE the broad invoice pattern", () => {
    // Same trap as assist sheets: the broker's own bill is invoice-shaped
    // and must never resolve to commercial_invoice.
    expect(normalizeRole("Broker Invoice")).toBe("broker_invoice");
    expect(normalizeRole("Expeditors Broker Invoice")).toBe("broker_invoice");
    expect(normalizeRole("Brokerage Invoice")).toBe("broker_invoice");
  });

  it("falls back to other for empty or unknown text", () => {
    expect(normalizeRole("")).toBe("other");
    expect(normalizeRole(null)).toBe("other");
    expect(normalizeRole("Handwritten note")).toBe("other");
  });
});

describe("roleToDocType", () => {
  it("routes assist sheets and unpipelined roles to other", () => {
    expect(roleToDocType("assist_sheet")).toBe("other");
    expect(roleToDocType("broker_invoice")).toBe("other");
    expect(roleToDocType("certificate_of_origin")).toBe("other");
  });

  it("routes pipelined roles to their extraction docType", () => {
    expect(roleToDocType("entry_summary_7501")).toBe("port_entry");
    expect(roleToDocType("hts_code_list")).toBe("tariff_code_sheet");
    expect(roleToDocType("commercial_invoice")).toBe("commercial_invoice");
    expect(roleToDocType("packing_list")).toBe("packing_list");
    expect(roleToDocType("transport_document")).toBe("shipment");
  });
});

describe("isEntryPacket", () => {
  it("a 7501 alone is sufficient", () => {
    expect(isEntryPacket(["Entry Summary 7501"])).toBe(true);
  });

  it("an ACH-packet filename is sufficient", () => {
    expect(isEntryPacket([], "ACH PACKET-4501341.pdf")).toBe(true);
  });

  it("an invoice needs a supporting doc alongside it", () => {
    expect(isEntryPacket(["Commercial Invoice"])).toBe(false);
    expect(isEntryPacket(["Commercial Invoice", "Packing List"])).toBe(true);
    expect(isEntryPacket(["Commercial Invoice", "Bill of Lading"])).toBe(true);
  });
});

describe("mapSplitToManifest", () => {
  it("builds a page-ordered manifest with normalized roles", () => {
    const manifest = mapSplitToManifest([
      { name: "Commercial Invoice", pages: [4, 3], conf: "high" },
      { name: "Entry Summary 7501", pages: [1, 2], conf: "low" },
      { name: "Mystery attachment", pages: [5], conf: "definitely" },
    ]);
    expect(manifest.parts).toEqual([
      {
        part_index: 1,
        role: "entry_summary_7501",
        doc_type: "port_entry",
        title: "Entry Summary 7501",
        pages: [1, 2],
        confidence: "low",
      },
      {
        part_index: 2,
        role: "commercial_invoice",
        doc_type: "commercial_invoice",
        title: "Commercial Invoice",
        pages: [3, 4],
        confidence: "high",
      },
      {
        part_index: 3,
        role: "other",
        doc_type: "other",
        title: "Mystery attachment",
        pages: [5],
        confidence: null,
      },
    ]);
  });

  it("accepts the DeepSplitResult page shape and drops empty parts", () => {
    const manifest = mapSplitToManifest([
      { name: "7501", pages: [{ page_number: 2 }, { page_number: 1 }, null] },
      { name: "Assist Sheet", pages: [null, undefined] },
    ]);
    expect(manifest.parts).toHaveLength(1);
    expect(manifest.parts[0].pages).toEqual([1, 2]);
  });

  it("throws when the split yields nothing usable", () => {
    expect(() => mapSplitToManifest([])).toThrow(ProcessingError);
    expect(() => mapSplitToManifest([{ name: "x", pages: [] }])).toThrow(
      ProcessingError,
    );
  });
});

describe("orderPacketParts", () => {
  it("processes 7501s, then invoices, then the rest", () => {
    const part = (
      part_index: number,
      role: PacketPartExtraction["role"],
    ): PacketPartExtraction => ({
      part_index,
      role,
      doc_type: roleToDocType(role),
      title: null,
      pages: [part_index],
      confidence: null,
    });
    const ordered = orderPacketParts([
      part(1, "packing_list"),
      part(2, "commercial_invoice"),
      part(3, "entry_summary_7501"),
      part(4, "assist_sheet"),
    ]);
    expect(ordered.map((p) => p.role)).toEqual([
      "entry_summary_7501",
      "commercial_invoice",
      "packing_list",
      "assist_sheet",
    ]);
  });
});

describe("childFileName / pageRangeLabel", () => {
  it("is deterministic and keeps the parent extension", () => {
    const part: PacketPartExtraction = {
      part_index: 2,
      role: "commercial_invoice",
      doc_type: "commercial_invoice",
      title: "Commercial Invoice",
      pages: [3, 4],
      confidence: "high",
    };
    expect(childFileName("entry-packet-231.pdf", part)).toBe(
      "entry-packet-231 - Commercial invoice (pp. 3–4).pdf",
    );
  });

  it("labels single pages as p. N", () => {
    expect(pageRangeLabel([5])).toBe("p. 5");
    expect(pageRangeLabel([3, 4])).toBe("pp. 3–4");
    expect(pageRangeLabel([])).toBeNull();
  });
});
