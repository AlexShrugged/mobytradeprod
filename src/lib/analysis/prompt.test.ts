import { describe, expect, it } from "vitest";

import { buildInitialUserMessage, buildSystemPrompt } from "./prompt";
import { fixtureBundle, fixtureRef as ref } from "./test-fixtures";

describe("buildInitialUserMessage", () => {
  it("leaves the briefing untouched when the catalog says nothing", () => {
    const briefing = JSON.parse(buildInitialUserMessage(fixtureBundle(), ref));
    expect(briefing).not.toHaveProperty("section232Catalog");
    for (const line of briefing.lines) expect(line).not.toHaveProperty("parts");
  });

  it("carries each line's SKUs and the importer's Section 232 marks", () => {
    const bundle = fixtureBundle();
    const lineNumber = bundle.snapshot.auditable.lines[0].lineNumber;
    bundle.lineParts.set(lineNumber, [
      { sku: "0560009078", source: "sheet", section232: "applies" },
      { sku: "0560428500", source: "invoice", section232: null },
    ]);
    bundle.section232Catalog = {
      applies: ["0560009078"],
      doesNotApply: [],
      unmarked: 1,
    };
    const briefing = JSON.parse(buildInitialUserMessage(bundle, ref));
    expect(briefing.lines[0].parts).toEqual([
      { sku: "0560009078", source: "sheet", section232: "applies" },
      { sku: "0560428500", source: "invoice", section232: null },
    ]);
    expect(briefing.section232Catalog).toEqual({
      applies: ["0560009078"],
      doesNotApply: [],
      unmarked: 1,
    });
  });
});

describe("buildSystemPrompt", () => {
  it("states the Section 232 mark doctrine, null included", () => {
    const prompt = buildSystemPrompt([]);
    expect(prompt).toContain("section232Catalog");
    expect(prompt).toContain("never read null as either answer");
  });
});
