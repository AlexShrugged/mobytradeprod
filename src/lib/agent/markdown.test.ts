import { describe, expect, it } from "vitest";

import { parseAgentMarkdown, parseInlines } from "./markdown";

describe("parseInlines", () => {
  it("parses bold, code, and internal links", () => {
    expect(
      parseInlines("See **HTS 8501** at `line 2` in [the variance](/variance/abc)"),
    ).toEqual([
      { type: "text", text: "See " },
      { type: "bold", text: "HTS 8501" },
      { type: "text", text: " at " },
      { type: "code", text: "line 2" },
      { type: "text", text: " in " },
      { type: "link", label: "the variance", href: "/variance/abc" },
    ]);
  });

  it("renders external and protocol-relative links as plain text", () => {
    expect(parseInlines("[evil](https://example.com)")).toEqual([
      { type: "text", text: "evil" },
    ]);
    expect(parseInlines("[evil](//example.com)")).toEqual([
      { type: "text", text: "evil" },
    ]);
  });
});

describe("parseAgentMarkdown", () => {
  it("splits paragraphs on blank lines and joins soft wraps", () => {
    const blocks = parseAgentMarkdown("one\ntwo\n\nthree");
    expect(blocks).toEqual([
      { type: "paragraph", inlines: [{ type: "text", text: "one two" }] },
      { type: "paragraph", inlines: [{ type: "text", text: "three" }] },
    ]);
  });

  it("parses unordered and ordered lists", () => {
    const blocks = parseAgentMarkdown("- a\n- b\n\n1. x\n2. y");
    expect(blocks).toEqual([
      {
        type: "list",
        ordered: false,
        items: [[{ type: "text", text: "a" }], [{ type: "text", text: "b" }]],
      },
      {
        type: "list",
        ordered: true,
        items: [[{ type: "text", text: "x" }], [{ type: "text", text: "y" }]],
      },
    ]);
  });

  it("parses headings and fenced code (even unterminated)", () => {
    expect(parseAgentMarkdown("## Findings")).toEqual([
      { type: "heading", level: 2, inlines: [{ type: "text", text: "Findings" }] },
    ]);
    expect(parseAgentMarkdown("```\ncode here\n```")).toEqual([
      { type: "codeblock", text: "code here" },
    ]);
    expect(parseAgentMarkdown("```\ndangling")).toEqual([
      { type: "codeblock", text: "dangling" },
    ]);
  });

  it("does not parse markdown inside code fences", () => {
    const blocks = parseAgentMarkdown("```\n- not a list\n```");
    expect(blocks).toEqual([{ type: "codeblock", text: "- not a list" }]);
  });
});
