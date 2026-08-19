import { describe, expect, it } from "vitest";

import {
  appendUserMessage,
  ELIDED_MARKER,
  normalizeContentBlocks,
  rebuildMessages,
  type WireMessage,
} from "./transcript";

const text = (t: string) => ({ type: "text", text: t });
const use = (id: string) => ({
  type: "tool_use",
  id,
  name: "get_variance_queue",
  input: {},
});
const result = (id: string, content = "ok") => ({
  type: "tool_result",
  tool_use_id: id,
  content,
});

describe("normalizeContentBlocks", () => {
  it("wraps string content in a text block", () => {
    expect(normalizeContentBlocks("hi")).toEqual([text("hi")]);
  });

  it("keeps arrays and drops junk entries", () => {
    expect(normalizeContentBlocks([text("a"), null, 3, { no: "type" }])).toEqual(
      [text("a")],
    );
    expect(normalizeContentBlocks({ not: "array" })).toEqual([]);
  });
});

describe("rebuildMessages", () => {
  it("rebuilds a clean transcript untouched", () => {
    const rows = [
      { role: "user", content: [text("q")] },
      { role: "assistant", content: [use("t1")] },
      { role: "user", content: [result("t1")] },
      { role: "assistant", content: [text("a")] },
    ];
    expect(rebuildMessages(rows)).toEqual(rows);
  });

  it("drops unknown roles and empty messages", () => {
    const rebuilt = rebuildMessages([
      { role: "system", content: [text("x")] },
      { role: "user", content: [] },
      { role: "user", content: [text("q")] },
    ]);
    expect(rebuilt).toEqual([{ role: "user", content: [text("q")] }]);
  });

  it("synthesizes results for a trailing dangling tool_use", () => {
    const rebuilt = rebuildMessages([
      { role: "user", content: [text("q")] },
      { role: "assistant", content: [use("t1"), use("t2")] },
    ]);
    expect(rebuilt).toHaveLength(3);
    const repair = rebuilt[2];
    expect(repair.role).toBe("user");
    expect(repair.content.map((b) => b.tool_use_id)).toEqual(["t1", "t2"]);
    expect(repair.content.every((b) => b.is_error === true)).toBe(true);
  });

  it("prepends missing results to a partial tool_result message", () => {
    const rebuilt = rebuildMessages([
      { role: "user", content: [text("q")] },
      { role: "assistant", content: [use("t1"), use("t2")] },
      { role: "user", content: [result("t2")] },
    ]);
    const repaired = rebuilt[2];
    expect(repaired.content.map((b) => b.tool_use_id)).toEqual(["t1", "t2"]);
    expect(repaired.content[0].is_error).toBe(true);
    expect(repaired.content[1].is_error).toBeUndefined();
  });

  it("elides the oldest tool_result bodies past the budget, protecting the tail", () => {
    const big = "x".repeat(500);
    const rows = [
      { role: "user", content: [text("q")] },
      { role: "assistant", content: [use("t1")] },
      { role: "user", content: [result("t1", big)] },
      { role: "assistant", content: [use("t2")] },
      { role: "user", content: [result("t2", big)] },
      { role: "assistant", content: [use("t3")] },
      { role: "user", content: [result("t3", big)] },
      { role: "assistant", content: [text("done")] },
    ];
    const rebuilt = rebuildMessages(rows, { budgetChars: 1_700 });
    expect(rebuilt[2].content[0].content).toBe(ELIDED_MARKER);
    // Elision stops once under budget, and the final four messages are
    // protected regardless.
    expect(rebuilt[4].content[0].content).toBe(big);
    expect(rebuilt[6].content[0].content).toBe(big);
  });

  it("leaves everything alone under the budget", () => {
    const rows = [
      { role: "user", content: [text("q")] },
      { role: "assistant", content: [use("t1")] },
      { role: "user", content: [result("t1", "small")] },
      { role: "assistant", content: [text("a")] },
    ];
    const rebuilt = rebuildMessages(rows, { budgetChars: 100_000 });
    expect(rebuilt[2].content[0].content).toBe("small");
  });
});

describe("appendUserMessage", () => {
  it("appends a new user message after an assistant message", () => {
    const messages: WireMessage[] = [
      { role: "assistant", content: [text("a")] },
    ];
    appendUserMessage(messages, "next");
    expect(messages).toHaveLength(2);
    expect(messages[1]).toEqual({ role: "user", content: [text("next")] });
  });

  it("merges into a trailing user message so roles alternate", () => {
    const messages: WireMessage[] = [
      { role: "assistant", content: [use("t1")] },
      { role: "user", content: [result("t1")] },
    ];
    appendUserMessage(messages, "next");
    expect(messages).toHaveLength(2);
    expect(messages[1].content).toEqual([result("t1"), text("next")]);
  });
});
