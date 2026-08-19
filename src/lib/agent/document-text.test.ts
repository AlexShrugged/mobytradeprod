import { describe, expect, it } from "vitest";

import { extractDocumentText } from "./document-text";

const block = (page: number) => ({ content: "b", type: "Text", bbox: { page } });
const chunk = (content: string, pages: number[]) => ({
  content,
  blocks: pages.map(block),
});

const raw = (chunks: unknown[]) => ({
  provider: "reducto",
  parse: { jobId: "j1", usage: null, result: { type: "full", chunks } },
  classify: null,
  extract: null,
  retrievedAt: "2026-08-18T00:00:00Z",
});

describe("extractDocumentText", () => {
  it("reads all chunks in order with page metadata", () => {
    const result = extractDocumentText(
      raw([chunk("first", [1]), chunk("second", [2, 3])]),
      { page: null, cursor: null },
    );
    expect(result).toMatchObject({
      ok: true,
      totalChunks: 2,
      pagesAvailable: [1, 2, 3],
      text: "first\n\nsecond",
      nextCursor: null,
    });
  });

  it("filters chunks by page", () => {
    const result = extractDocumentText(
      raw([chunk("p1", [1]), chunk("p2", [2]), chunk("p2b", [2])]),
      { page: 2, cursor: null },
    );
    expect(result).toMatchObject({ ok: true, totalChunks: 2, text: "p2\n\np2b" });
  });

  it("errors on a page with no text, naming the pages that have some", () => {
    const result = extractDocumentText(raw([chunk("p1", [1])]), {
      page: 9,
      cursor: null,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("Pages with text: 1");
  });

  it("paginates by cursor under the char cap", () => {
    const chunks = [chunk("a".repeat(60), [1]), chunk("b".repeat(60), [2])];
    const first = extractDocumentText(raw(chunks), {
      page: null,
      cursor: null,
      maxChars: 80,
    });
    expect(first).toMatchObject({ ok: true, nextCursor: 1 });
    if (first.ok) expect(first.text).toBe("a".repeat(60));
    const second = extractDocumentText(raw(chunks), {
      page: null,
      cursor: 1,
      maxChars: 80,
    });
    expect(second).toMatchObject({ ok: true, nextCursor: null });
    if (second.ok) expect(second.text).toBe("b".repeat(60));
  });

  it("truncates a single oversized chunk and keeps the cursor moving", () => {
    const result = extractDocumentText(raw([chunk("z".repeat(200), [1])]), {
      page: null,
      cursor: null,
      maxChars: 50,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.text).toContain("[chunk truncated");
      expect(result.nextCursor).toBeNull();
    }
  });

  it("errors on a cursor past the end", () => {
    const result = extractDocumentText(raw([chunk("a", [1])]), {
      page: null,
      cursor: 5,
    });
    expect(result.ok).toBe(false);
  });

  it("errors on stub payloads (no chunks)", () => {
    expect(extractDocumentText(null, { page: null, cursor: null }).ok).toBe(
      false,
    );
    expect(
      extractDocumentText(raw([]), { page: null, cursor: null }).ok,
    ).toBe(false);
  });
});
