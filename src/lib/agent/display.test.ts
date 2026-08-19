import { describe, expect, it } from "vitest";

import {
  collectToolResults,
  condensedToolLabel,
  describeToolCall,
  summarizeToolResult,
  toDisplayMessage,
} from "./display";

describe("describeToolCall", () => {
  it("labels calls from their input", () => {
    expect(describeToolCall("search_entries", { q: "China" })).toBe(
      'Entries matching "China"',
    );
    expect(describeToolCall("search_entries", { q: null })).toBe("Entries");
    expect(describeToolCall("get_entry", { entryId: "e1" })).toBe(
      "Entry detail",
    );
    expect(describeToolCall("get_variance_queue", { status: null })).toBe(
      "Variance queue (open)",
    );
    expect(
      describeToolCall("get_expected_charges", { lineNumber: 3 }),
    ).toBe("Expected charges, line 3");
    expect(describeToolCall("get_measures", { hts: "9903.01.25" })).toBe(
      "Measures for 9903.01.25",
    );
    expect(describeToolCall("read_document_text", { page: 2 })).toBe(
      "Document text, page 2",
    );
    expect(describeToolCall("read_document_text", { page: null })).toBe(
      "Document text",
    );
    expect(
      describeToolCall("propose_actions", { actions: [{}, {}] }),
    ).toBe("Proposing 2 actions");
  });

  it("falls back to the tool name for unknown tools", () => {
    expect(describeToolCall("mystery_tool", {})).toBe("mystery_tool");
  });
});

describe("summarizeToolResult", () => {
  it("labels outcomes from the persisted result text", () => {
    expect(
      summarizeToolResult("search_entries", JSON.stringify({ matched: 11 })),
    ).toEqual({ ok: true, summary: "11 entries" });
    expect(
      summarizeToolResult("get_entry", JSON.stringify({ entryNumber: "E-1" })),
    ).toEqual({ ok: true, summary: "Entry E-1" });
    expect(
      summarizeToolResult(
        "get_variance_detail",
        JSON.stringify({ kind: "alert", alert: { label: "Rate mismatch" } }),
      ),
    ).toEqual({ ok: true, summary: "Rate mismatch" });
    expect(
      summarizeToolResult(
        "propose_actions",
        JSON.stringify({ created: [{}], errors: ["bad"] }),
      ),
    ).toEqual({ ok: true, summary: "1 proposed, 1 rejected" });
  });

  it("marks ERROR results failed and stays quiet on unparseable text", () => {
    const err = summarizeToolResult("get_entry", "ERROR: no entry with id x.");
    expect(err.ok).toBe(false);
    expect(err.summary).toContain("ERROR: no entry");
    expect(summarizeToolResult("get_entry", "not json{")).toEqual({
      ok: true,
      summary: null,
    });
    expect(
      summarizeToolResult("get_measures", JSON.stringify({ some: "payload" })),
    ).toEqual({ ok: true, summary: null });
  });
});

describe("condensedToolLabel", () => {
  it("names a run of same-tool calls", () => {
    expect(condensedToolLabel("get_entry", 11)).toBe("Read 11 entries");
    expect(condensedToolLabel("search_entries", 2)).toBe(
      "Searched entries ×2",
    );
    expect(condensedToolLabel("unknown_tool", 3)).toBe("unknown_tool ×3");
  });
});

describe("toDisplayMessage tool chips", () => {
  const assistantRow = {
    id: "m2",
    seq: 2,
    role: "assistant",
    content: [
      { type: "text", text: "Looking." },
      {
        type: "tool_use",
        id: "t1",
        name: "get_entry",
        input: { entryId: "e1" },
      },
    ],
    createdAt: "2026-08-18T00:00:00.000Z",
  };
  const resultRow = {
    content: [
      {
        type: "tool_result",
        tool_use_id: "t1",
        content: JSON.stringify({ entryNumber: "231-4501341-1" }),
      },
    ],
  };

  it("carries the same summary and result the live chips showed", () => {
    const message = toDisplayMessage(
      assistantRow,
      collectToolResults([resultRow]),
    );
    expect(message?.blocks[1]).toEqual({
      type: "tool_use",
      name: "get_entry",
      summary: "Entry detail",
      result: "Entry 231-4501341-1",
      ok: true,
    });
  });

  it("renders an ok chip with no result when the result row is missing", () => {
    const message = toDisplayMessage(assistantRow);
    expect(message?.blocks[1]).toMatchObject({
      type: "tool_use",
      summary: "Entry detail",
      result: null,
      ok: true,
    });
  });

  it("marks a chip failed from an ERROR tool_result", () => {
    const message = toDisplayMessage(
      assistantRow,
      collectToolResults([
        {
          content: [
            {
              type: "tool_result",
              tool_use_id: "t1",
              content: "ERROR: no entry with id e1.",
            },
          ],
        },
      ]),
    );
    expect(message?.blocks[1]).toMatchObject({
      ok: false,
      result: "ERROR: no entry with id e1.",
    });
  });
});
