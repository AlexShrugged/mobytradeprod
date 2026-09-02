// The Claude scoping pass, driven through a fake parse client: what it
// sends (change, table, literal marks), how it reads replies (hyphen-
// insensitive entry numbers, unknowns dropped, "all"), every failure
// falling back to "no opinion", and the merge doctrine — the named floor
// never shrinks, "everything" shrinks only to a non-empty pick.

import { describe, expect, it, vi, type Mock } from "vitest";

import type { RelevanceEntry, RelevanceLine, RuleReach } from "./rule-relevance";
import {
  ClaudeRuleScoper,
  buildScopeTable,
  dotHts,
  interpretScope,
  mergeReach,
  type RuleChange,
  type ScopeParseClient,
} from "./rule-scope";

function line(over: Partial<RelevanceLine> = {}): RelevanceLine {
  return {
    supplierName: null,
    vendorName: null,
    countryOfOrigin: "CN",
    htsCodeDigits: "8714100050",
    chargeHtsDigits: [],
    skus: [],
    ...over,
  };
}

const entries: RelevanceEntry[] = [
  {
    entryId: "e1",
    entryNumber: "231-7354574-7",
    lines: [
      line({
        supplierName: "SHENZHEN FOO TECHNOLOGY CO., LTD.",
        skus: ["EB-500", " EB-500 ", "EB-501"],
        chargeHtsDigits: ["8714100050", "99038201", "499"],
      }),
    ],
    openAlertTypes: ["hts_mismatch", "hts_mismatch"],
    openFindings: [{ category: "classification", title: "Frame vs part" }],
  },
  {
    entryId: "e2",
    entryNumber: "231-7376568-3",
    lines: [
      line({ supplierName: "Giant Manufacturing Co Ltd", countryOfOrigin: "TW", htsCodeDigits: "871200" }),
    ],
  },
  {
    entryId: "e3",
    entryNumber: "231-7377083-2",
    lines: [line({ supplierName: "ACME INDUSTRIES INC", countryOfOrigin: "VN" })],
  },
];

const change: RuleChange = {
  before: null,
  after: { text: "Packing list weights are unreliable.", suppression: null },
};

type Reply = { parsed_output: unknown; stop_reason: string | null };
type ParseFn = (params: unknown, options?: unknown) => Promise<Reply>;

function fakeClient(reply: Reply | (() => Reply)) {
  const parse: Mock<ParseFn> = vi.fn<ParseFn>(async () =>
    typeof reply === "function" ? reply() : reply,
  );
  const client = { messages: { parse } } as unknown as ScopeParseClient;
  return { client, parse };
}

const sentContent = (parse: Mock<ParseFn>): string => {
  const params = parse.mock.calls[0][0] as { messages: { content: string }[] };
  return params.messages[0].content;
};

describe("dotHts", () => {
  it("dots digit runs the way a schedule prints them", () => {
    expect(dotHts("8714100050")).toBe("8714.10.00.50");
    expect(dotHts("99038201")).toBe("9903.82.01");
    expect(dotHts("871410")).toBe("8714.10");
    expect(dotHts("499")).toBe("499");
  });
});

describe("buildScopeTable", () => {
  it("renders compact rows with Chapter 99 headings only and literal marks", () => {
    const table = buildScopeTable(entries, { all: false, entryIds: ["e2"] });
    expect(table[0]).toEqual({
      entryNumber: "231-7354574-7",
      suppliers: ["SHENZHEN FOO TECHNOLOGY CO., LTD."],
      countries: ["CN"],
      htsCodes: ["8714.10.00.50"],
      chargeHeadings: ["9903.82.01"],
      skus: ["EB-500", "EB-501"],
      openAlerts: ["hts_mismatch"],
      openFindings: ["classification: Frame vs part"],
      literalMatch: false,
    });
    expect(table[1].literalMatch).toBe(true);
    expect(table[2].openAlerts).toEqual([]);
  });

  it("marks nothing literal when the deterministic reach is everything", () => {
    const table = buildScopeTable(entries, { all: true });
    expect(table.every((r) => !r.literalMatch)).toBe(true);
  });
});

describe("interpretScope", () => {
  it("maps entry numbers back hyphen-insensitively and drops unknowns", () => {
    const scope = interpretScope(
      {
        scope: "entries",
        reasoning: "supplier rule",
        entries: [
          { entryNumber: "23173545747", reason: "Foo's entry" },
          { entryNumber: "231-7354574-7", reason: "duplicate" },
          { entryNumber: "999-9999999-9", reason: "not in the book" },
        ],
      },
      entries,
    );
    expect(scope).toEqual({
      all: false,
      reasoning: "supplier rule",
      picks: [{ entryId: "e1", entryNumber: "231-7354574-7", reason: "Foo's entry" }],
    });
  });

  it("passes 'all' through", () => {
    expect(
      interpretScope({ scope: "all", reasoning: "broker conduct", entries: [] }, entries),
    ).toEqual({ all: true, reasoning: "broker conduct" });
  });
});

describe("ClaudeRuleScoper", () => {
  it("sends the change and the table, and reads the picks", async () => {
    const { client, parse } = fakeClient({
      parsed_output: {
        scope: "entries",
        reasoning: "only Foo ships with packing lists",
        entries: [{ entryNumber: "231-7354574-7", reason: "Foo packing list" }],
      },
      stop_reason: "end_turn",
    });
    const scoper = new ClaudeRuleScoper({ client, model: "test-model" });
    const scope = await scoper.scope(change, entries, { all: true });
    expect(scope).toEqual({
      all: false,
      reasoning: "only Foo ships with packing lists",
      picks: [{ entryId: "e1", entryNumber: "231-7354574-7", reason: "Foo packing list" }],
    });

    const sent = JSON.parse(sentContent(parse));
    expect(sent.change).toEqual({ kind: "created", before: null, after: change.after });
    expect(sent.literalMatch).toMatch(/nothing literal/);
    expect(sent.entries).toHaveLength(3);
    expect(sent.entries[0].openFindings).toEqual(["classification: Frame vs part"]);

    const params = parse.mock.calls[0][0] as { model: string };
    expect(params.model).toBe("test-model");
    expect(parse.mock.calls[0][1]).toEqual({ timeout: 60_000 });
  });

  it("labels edits and removals and reports the literal count", async () => {
    const { client, parse } = fakeClient({
      parsed_output: { scope: "all", reasoning: "", entries: [] },
      stop_reason: "end_turn",
    });
    const scoper = new ClaudeRuleScoper({ client });
    const before = { text: "Old text", suppression: null };
    const after = { text: "New text", suppression: null };
    await scoper.scope({ before, after }, entries, { all: false, entryIds: ["e1", "e3"] });
    const edited = JSON.parse(sentContent(parse));
    expect(edited.change.kind).toBe("edited");
    expect(edited.literalMatch).toBe("2 of 3 entries, marked literalMatch");

    parse.mockClear();
    await scoper.scope({ before, after: null }, entries, { all: true });
    expect(JSON.parse(sentContent(parse)).change.kind).toBe("removed");
  });

  it("has no opinion on a refusal, a missing parse, or a thrown error", async () => {
    const refused = new ClaudeRuleScoper({
      client: fakeClient({ parsed_output: null, stop_reason: "refusal" }).client,
    });
    expect(await refused.scope(change, entries, { all: true })).toBeNull();

    const unparsed = new ClaudeRuleScoper({
      client: fakeClient({ parsed_output: null, stop_reason: "end_turn" }).client,
    });
    expect(await unparsed.scope(change, entries, { all: true })).toBeNull();

    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const thrown = new ClaudeRuleScoper({
      client: fakeClient(() => {
        throw new Error("boom");
      }).client,
    });
    expect(await thrown.scope(change, entries, { all: true })).toBeNull();
    spy.mockRestore();
  });

  it("skips the call on an empty or oversized book", async () => {
    const { client, parse } = fakeClient({
      parsed_output: { scope: "all", reasoning: "", entries: [] },
      stop_reason: "end_turn",
    });
    const scoper = new ClaudeRuleScoper({ client, maxEntries: 2 });
    expect(await scoper.scope(change, [], { all: true })).toBeNull();
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await scoper.scope(change, entries, { all: true })).toBeNull();
    spy.mockRestore();
    expect(parse).not.toHaveBeenCalled();
  });
});

describe("mergeReach", () => {
  const named: RuleReach = { all: false, entryIds: ["e1", "e2"] };
  const everything: RuleReach = { all: true };
  const picks = (...ids: string[]) => ({
    all: false as const,
    reasoning: "",
    picks: ids.map((id) => ({ entryId: id, entryNumber: id, reason: "" })),
  });

  it("keeps the deterministic reach when the model has no opinion", () => {
    expect(mergeReach(named, null)).toEqual(named);
    expect(mergeReach(everything, null)).toEqual(everything);
  });

  it("lets the model shrink everything, but only to a non-empty pick", () => {
    expect(mergeReach(everything, picks("e3", "e3"))).toEqual({
      all: false,
      entryIds: ["e3"],
    });
    expect(mergeReach(everything, picks())).toEqual(everything);
    expect(mergeReach(everything, { all: true, reasoning: "" })).toEqual(everything);
  });

  it("never shrinks a named set, only widens it", () => {
    expect(mergeReach(named, picks("e3"))).toEqual({
      all: false,
      entryIds: ["e1", "e2", "e3"],
    });
    expect(mergeReach(named, picks("e1"))).toEqual(named);
    expect(mergeReach(named, picks())).toEqual(named);
    expect(mergeReach(named, { all: true, reasoning: "" })).toEqual(everything);
  });
});
