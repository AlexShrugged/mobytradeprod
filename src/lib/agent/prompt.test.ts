// describePageContext: pathname -> the prompt's "where the user started"
// description. Pure; ids pass through verbatim so the model can hand them
// to get_variance_detail / get_entry.

import { describe, expect, it } from "vitest";

import { buildSystemPrompt, describePageContext } from "./prompt";

describe("describePageContext", () => {
  it("null stays null (assistant threads carry no context)", () => {
    expect(describePageContext(null)).toBeNull();
  });

  it("detail pages name the id and the tool to use", () => {
    expect(describePageContext("/variance/abc-123")).toContain(
      "the variance detail page for alert or finding id abc-123",
    );
    expect(describePageContext("/variance/abc-123")).toContain(
      "get_variance_detail",
    );
    expect(describePageContext("/variance/abc-123")).toContain(
      "save_org_rule",
    );
    expect(describePageContext("/entries/e-9")).toBe(
      "the entry detail page for entry id e-9 (use get_entry)",
    );
  });

  it("known list pages are named; unknown paths pass through", () => {
    expect(describePageContext("/variance")).toBe("the variance queue");
    expect(describePageContext("/parts")).toBe("the Parts page");
    expect(describePageContext("/somewhere/else")).toBe(
      "the page at /somewhere/else",
    );
  });
});

describe("buildSystemPrompt", () => {
  const base = { orgName: "Waystar", todayIso: "2026-08-19" };

  it("lists rules and marks suppression ones", () => {
    const prompt = buildSystemPrompt({
      ...base,
      orgRules: [
        { text: "Always check AD/CVD.", isSuppression: false },
        { text: "Ignore invoice skips.", isSuppression: true },
      ],
    });
    expect(prompt).toContain("- Always check AD/CVD.");
    expect(prompt).toContain(
      "- Ignore invoice skips. (also hides matching variance alerts)",
    );
  });

  it("shows the empty state and omits context when absent", () => {
    const prompt = buildSystemPrompt({ ...base, orgRules: [] });
    expect(prompt).toContain("- None recorded yet.");
    expect(prompt).not.toContain("Where the user started");
  });

  it("appends the page-context block last when present", () => {
    const prompt = buildSystemPrompt({
      ...base,
      orgRules: [],
      pageContext: "the variance queue",
    });
    expect(prompt).toContain(
      "The user opened this chat from the variance queue.",
    );
    expect(prompt.indexOf("Where the user started")).toBeGreaterThan(
      prompt.indexOf("Org rules:"),
    );
  });
});
