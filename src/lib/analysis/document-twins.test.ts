import { describe, expect, it } from "vitest";

import {
  collapseTwinUploads,
  type TwinDocument,
  type TwinParent,
} from "./document-twins";

const at = (h: number) => new Date(Date.UTC(2026, 7, 19, h));

function doc(over: Partial<TwinDocument> & { id: string }): TwinDocument {
  return {
    fileName: `${over.id}.pdf`,
    status: "processed",
    parentDocumentId: null,
    contentHash: null,
    processedAt: at(10),
    uploadedAt: at(9),
    ...over,
  };
}

describe("collapseTwinUploads", () => {
  it("keeps the twin processed last and names the other upload on it", () => {
    // ASC 231-7354575-4: one 7501 uploaded twice, extracted twice.
    const five = doc({
      id: "d5",
      fileName: "MobyTrade Part 2 (5).pdf",
      contentHash: "h1",
      uploadedAt: at(18),
      processedAt: at(18.1),
    });
    const eight = doc({
      id: "d8",
      fileName: "MobyTrade Part 2 (8).pdf",
      contentHash: "h1",
      uploadedAt: at(20),
      processedAt: at(20.1),
    });
    const invoice = doc({ id: "ci", contentHash: "h2" });
    const out = collapseTwinUploads([five, eight, invoice], new Map());
    expect([...out.keptIds].sort()).toEqual(["ci", "d8"]);
    expect(out.sameBytesAs.get("d8")).toEqual([
      { id: "d5", fileName: "MobyTrade Part 2 (5).pdf" },
    ]);
    expect(out.sameBytesAs.has("ci")).toBe(false);
    expect(out.collapsed).toEqual([
      { id: "d5", fileName: "MobyTrade Part 2 (5).pdf", keptIds: ["d8"] },
    ]);
  });

  it("prefers a processed copy over a later failed one", () => {
    const good = doc({ id: "a", contentHash: "h", processedAt: at(10) });
    const bad = doc({
      id: "b",
      contentHash: "h",
      status: "failed",
      processedAt: at(12),
      uploadedAt: at(11),
    });
    const out = collapseTwinUploads([good, bad], new Map());
    expect([...out.keptIds]).toEqual(["a"]);
    expect(out.collapsed[0]).toMatchObject({ id: "b", keptIds: ["a"] });
  });

  it("collapses packet children by their parent's bytes", () => {
    // The 2026-09-11 re-drag: each packet uploaded twice, each split into
    // children that link to the entry; parents never do.
    const parents = new Map<string, TwinParent>([
      [
        "p1",
        {
          id: "p1",
          fileName: "7077844574.pdf",
          status: "processed",
          contentHash: "hp",
          processedAt: at(17),
          uploadedAt: at(16),
        },
      ],
      [
        "p2",
        {
          id: "p2",
          fileName: "7077844574.pdf",
          status: "processed",
          contentHash: "hp",
          processedAt: at(18),
          uploadedAt: at(17.5),
        },
      ],
    ]);
    const docs = [
      doc({ id: "c1a", parentDocumentId: "p1", processedAt: at(17.1) }),
      doc({ id: "c1b", parentDocumentId: "p1", processedAt: at(17.2) }),
      doc({ id: "c2a", parentDocumentId: "p2", processedAt: at(18.1) }),
      doc({ id: "c2b", parentDocumentId: "p2", processedAt: at(18.2) }),
      doc({ id: "loose", contentHash: "hx" }),
    ];
    const out = collapseTwinUploads(docs, parents);
    expect([...out.keptIds].sort()).toEqual(["c2a", "c2b", "loose"]);
    expect(out.sameBytesAs.get("c2a")).toEqual([
      { id: "p1", fileName: "7077844574.pdf" },
    ]);
    expect(out.sameBytesAs.get("c2b")).toEqual([
      { id: "p1", fileName: "7077844574.pdf" },
    ]);
    expect(out.collapsed).toEqual([
      { id: "c1a", fileName: "c1a.pdf", keptIds: ["c2a", "c2b"] },
      { id: "c1b", fileName: "c1b.pdf", keptIds: ["c2a", "c2b"] },
    ]);
  });

  it("collapses nothing without a shared hash", () => {
    const docs = [
      doc({ id: "a", contentHash: null }),
      doc({ id: "b", contentHash: null }),
      doc({ id: "c", contentHash: "h1" }),
      doc({ id: "d", contentHash: "h2" }),
      // A child whose parent the loader could not find.
      doc({ id: "e", parentDocumentId: "gone" }),
    ];
    const out = collapseTwinUploads(docs, new Map());
    expect(out.keptIds.size).toBe(5);
    expect(out.sameBytesAs.size).toBe(0);
    expect(out.collapsed).toEqual([]);
  });

  it("collapses three uploads to one and lists both others", () => {
    const docs = [
      doc({ id: "a", contentHash: "h", processedAt: at(1) }),
      doc({ id: "b", contentHash: "h", processedAt: at(3) }),
      doc({ id: "c", contentHash: "h", processedAt: at(2) }),
    ];
    const out = collapseTwinUploads(docs, new Map());
    expect([...out.keptIds]).toEqual(["b"]);
    expect(out.sameBytesAs.get("b")?.map((t) => t.id)).toEqual(["c", "a"]);
    expect(out.collapsed.map((c) => c.id)).toEqual(["a", "c"]);
  });
});
