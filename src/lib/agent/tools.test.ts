import { describe, expect, it } from "vitest";

import type {
  VarianceDetail,
  VarianceQueueRow,
  VarianceSiblingAlert,
} from "../db/queries/variance";
import { buildAgentTools } from "./tools";
import type {
  AgentEvent,
  AgentProposalPayload,
  AgentToolCtx,
  AgentToolDeps,
} from "./types";

type RunnableLike = { name: string; run: (input: unknown) => Promise<string> };

function makeCtx() {
  const events: AgentEvent[] = [];
  const ctx: AgentToolCtx = {
    trace: [],
    sink: { emit: (e) => events.push(e) },
    pendingProposalIds: [],
    lastToolSummary: null,
  };
  return { ctx, events };
}

const notFaked =
  (name: string) =>
  async (): Promise<never> => {
    throw new Error(`${name} not faked`);
  };

function makeDeps(overrides: Partial<AgentToolDeps>): AgentToolDeps {
  return {
    todayIso: () => "2026-08-18",
    getVarianceQueue: notFaked("getVarianceQueue"),
    getVarianceDetail: notFaked("getVarianceDetail"),
    getAiVarianceDetail: notFaked("getAiVarianceDetail"),
    searchEntries: notFaked("searchEntries"),
    getEntryDetail: notFaked("getEntryDetail"),
    getEntryHeader: notFaked("getEntryHeader"),
    searchParts: notFaked("searchParts"),
    listDocuments: notFaked("listDocuments"),
    getDocumentsForEntryNumber: notFaked("getDocumentsForEntryNumber"),
    getDocumentExtraction: notFaked("getDocumentExtraction"),
    getDocumentRawExtraction: notFaked("getDocumentRawExtraction"),
    getExpectedCharges: notFaked("getExpectedCharges"),
    getMeasures: notFaked("getMeasures"),
    createProposals: notFaked("createProposals"),
    ...overrides,
  };
}

function tool(deps: AgentToolDeps, ctx: AgentToolCtx, name: string) {
  const tools = buildAgentTools(deps, ctx) as unknown as RunnableLike[];
  const found = tools.find((t) => t.name === name);
  if (!found) throw new Error(`no tool ${name}`);
  return found;
}

const WINDOW: VarianceQueueRow["window"] = {
  estDate: null,
  daysLeft: null,
  closed: false,
  phase: "submitted",
  nextPhaseDate: null,
  nextPhaseDaysLeft: null,
};

const queueRow = (over: Partial<VarianceQueueRow>): VarianceQueueRow => ({
  alertId: "a1",
  alertKey: "rate_mismatch:line1:x",
  alertType: "rate_mismatch",
  status: "open",
  severity: "error",
  label: "Rate mismatch",
  message: "",
  details: null,
  entryId: "e1",
  entryNumber: "E-1",
  entryDate: "2026-01-01",
  entryStatus: "filed",
  lineItemId: "li1",
  lineNumber: 1,
  sku: "SKU1",
  description: null,
  partId: null,
  declaredHts: null,
  catalogHts: null,
  impactCents: 1000,
  direction: "recoverable",
  window: WINDOW,
  href: "/variance/a1",
  ...over,
});

const sibling = (
  id: string,
  alertType: string,
  alertKey: string,
  status: "open" | "resolved" | "dismissed",
): VarianceSiblingAlert => ({
  id,
  alertKey,
  alertType,
  severity: "error",
  label: alertType,
  message: "",
  status,
  resolvedAt: null,
  impactCents: 500,
  direction: "recoverable",
  details: null,
});

const detailFixture = (
  siblings: VarianceSiblingAlert[],
  alertOver: Partial<VarianceDetail["alert"]> = {},
): VarianceDetail =>
  ({
    alert: {
      id: "a1",
      alertKey: "rate_mismatch:line1:x",
      alertType: "rate_mismatch",
      severity: "error",
      label: "Rate mismatch",
      message: "",
      details: null,
      status: "open",
      resolutionNote: null,
      lineItemId: "li1",
      partId: null,
      ...alertOver,
    },
    entry: {
      id: "e1",
      entryNumber: "E-1",
      entryDate: "2026-01-01",
      status: "filed",
      portOfEntry: null,
    },
    window: WINDOW,
    line: null,
    impact: { impactCents: 1500, direction: "recoverable" },
    catalogExpected: null,
    documents: [],
    invoices: [],
    siblings,
  }) as unknown as VarianceDetail;

describe("get_variance_queue", () => {
  it("defaults to open rows, filters, caps, and reports a summary", async () => {
    const { ctx, events } = makeCtx();
    const deps = makeDeps({
      getVarianceQueue: async () => [
        queueRow({}),
        queueRow({ alertId: "a2", status: "resolved" }),
        queueRow({ alertId: "a3", alertType: "value_mismatch" }),
      ],
    });
    const out = await tool(deps, ctx, "get_variance_queue").run({
      status: null,
      alertType: "rate_mismatch",
      entryNumber: null,
      limit: null,
    });
    const parsed = JSON.parse(out) as { matched: number; rows: { id: string }[] };
    expect(parsed.matched).toBe(1);
    expect(parsed.rows[0].id).toBe("a1");
    const finished = events.find((e) => e.type === "tool_finished");
    expect(finished).toMatchObject({ ok: true, summary: "1 rows" });
  });
});

describe("error and truncation conventions", () => {
  it("returns an ERROR string for an unknown id and marks the chip failed", async () => {
    const { ctx, events } = makeCtx();
    const deps = makeDeps({
      getVarianceDetail: async () => null,
      getAiVarianceDetail: async () => null,
    });
    const out = await tool(deps, ctx, "get_variance_detail").run({ id: "nope" });
    expect(out.startsWith("ERROR:")).toBe(true);
    expect(events.find((e) => e.type === "tool_finished")).toMatchObject({
      ok: false,
    });
  });

  it("converts a thrown dep into an ERROR string (tools never throw)", async () => {
    const { ctx } = makeCtx();
    const out = await tool(makeDeps({}), ctx, "get_variance_queue").run({
      status: null,
      alertType: null,
      entryNumber: null,
      limit: null,
    });
    expect(out.startsWith("ERROR:")).toBe(true);
    expect(out).toContain("getVarianceQueue not faked");
  });

  it("caps oversized payloads with a truncation notice", async () => {
    const { ctx } = makeCtx();
    const deps = makeDeps({
      getDocumentExtraction: async () => ({
        id: "d1",
        fileName: "big.pdf",
        docType: "other",
        status: "processed",
        packetRole: null,
        pageRange: null,
        parentDocumentId: null,
        uploadedAt: null,
        extractedData: "x".repeat(40_000),
      }),
    });
    const out = await tool(deps, ctx, "read_document").run({
      documentId: "d1",
    });
    expect(out.length).toBeLessThan(25_000);
    expect(out).toContain("narrow the request");
  });
});

describe("propose_actions", () => {
  it("expands the rate/amount twin into one unit and stages the proposal", async () => {
    const { ctx, events } = makeCtx();
    const created: AgentProposalPayload[][] = [];
    const deps = makeDeps({
      getVarianceDetail: async () =>
        detailFixture([
          sibling("a1", "rate_mismatch", "rate_mismatch:line1:x", "open"),
          sibling("a2", "amount_mismatch", "amount_mismatch:line1:x", "open"),
          sibling("a3", "coo_discrepancy", "coo_discrepancy:line1", "open"),
        ]),
      createProposals: async (payloads) => {
        created.push(payloads);
        return payloads.map((p, i) => ({
          id: `p${i}`,
          conversationId: "c1",
          messageId: null,
          kind: p.kind,
          payload: p,
          status: "proposed" as const,
          decidedAt: null,
          results: null,
          createdAt: "2026-08-18T00:00:00.000Z",
          liveStatuses: null,
        }));
      },
    });
    const out = await tool(deps, ctx, "propose_actions").run({
      actions: [
        {
          kind: "alert_decision",
          alertId: "a1",
          decision: "resolved",
          note: "Expected rate confirmed by get_expected_charges.",
          entryId: null,
          reason: null,
        },
      ],
    });
    expect(out.startsWith("ERROR:")).toBe(false);
    const payload = created[0][0] as Extract<
      AgentProposalPayload,
      { kind: "alert_decision" }
    >;
    expect(payload.unitIds).toEqual(["a1", "a2"]);
    expect(payload.entryNumber).toBe("E-1");
    expect(payload.impactCents).toBe(1500);
    expect(ctx.pendingProposalIds).toEqual(["p0"]);
    expect(events.some((e) => e.type === "proposal")).toBe(true);
  });

  it("expands the unit when targeting the amount twin too", async () => {
    const { ctx } = makeCtx();
    const created: AgentProposalPayload[][] = [];
    const deps = makeDeps({
      getVarianceDetail: async () =>
        detailFixture(
          [
            sibling("a1", "rate_mismatch", "rate_mismatch:line1:x", "open"),
            sibling("a2", "amount_mismatch", "amount_mismatch:line1:x", "open"),
          ],
          { id: "a2", alertType: "amount_mismatch" },
        ),
      createProposals: async (payloads) => {
        created.push(payloads);
        return [];
      },
    });
    await tool(deps, ctx, "propose_actions").run({
      actions: [
        {
          kind: "alert_decision",
          alertId: "a2",
          decision: "dismissed",
          note: "Not actionable.",
          entryId: null,
          reason: null,
        },
      ],
    });
    const payload = created[0][0] as Extract<
      AgentProposalPayload,
      { kind: "alert_decision" }
    >;
    expect(payload.unitIds.sort()).toEqual(["a1", "a2"]);
  });

  it("rejects deciding an already-decided unit and reopening an open one", async () => {
    const { ctx } = makeCtx();
    let createCalls = 0;
    const deps = makeDeps({
      getVarianceDetail: async () =>
        detailFixture(
          [sibling("a1", "coo_discrepancy", "coo_discrepancy:line1", "resolved")],
          { status: "resolved" },
        ),
      createProposals: async () => {
        createCalls += 1;
        return [];
      },
    });
    const out = await tool(deps, ctx, "propose_actions").run({
      actions: [
        {
          kind: "alert_decision",
          alertId: "a1",
          decision: "resolved",
          note: "n",
          entryId: null,
          reason: null,
        },
      ],
    });
    expect(out.startsWith("ERROR:")).toBe(true);
    expect(out).toContain("already resolved");
    expect(createCalls).toBe(0);
  });

  it("validates analyze_entry against a real entry", async () => {
    const { ctx } = makeCtx();
    const created: AgentProposalPayload[][] = [];
    const deps = makeDeps({
      getEntryHeader: async (id) =>
        id === "e1" ? { id: "e1", entryNumber: "E-1" } : null,
      createProposals: async (payloads) => {
        created.push(payloads);
        return [];
      },
    });
    const bad = await tool(deps, ctx, "propose_actions").run({
      actions: [
        {
          kind: "analyze_entry",
          alertId: null,
          decision: null,
          note: null,
          entryId: "missing",
          reason: "check",
        },
      ],
    });
    expect(bad.startsWith("ERROR:")).toBe(true);
    await tool(deps, ctx, "propose_actions").run({
      actions: [
        {
          kind: "analyze_entry",
          alertId: null,
          decision: null,
          note: null,
          entryId: "e1",
          reason: "Re-check after reclassification.",
        },
      ],
    });
    expect(created[0][0]).toMatchObject({
      kind: "analyze_entry",
      entryNumber: "E-1",
    });
  });

  it("stages a guidance save_org_rule from ruleText alone", async () => {
    const { ctx, events } = makeCtx();
    const created: AgentProposalPayload[][] = [];
    const deps = makeDeps({
      createProposals: async (payloads) => {
        created.push(payloads);
        return payloads.map((p, i) => ({
          id: `p${i}`,
          conversationId: "c1",
          messageId: null,
          kind: p.kind,
          payload: p,
          status: "proposed" as const,
          decidedAt: null,
          results: null,
          createdAt: "2026-08-18T00:00:00.000Z",
          liveStatuses: null,
        }));
      },
    });
    const out = await tool(deps, ctx, "propose_actions").run({
      actions: [
        {
          kind: "save_org_rule",
          alertId: null,
          decision: null,
          note: null,
          entryId: null,
          reason: null,
          ruleText: "  Always check type 03 entries for AD/CVD consistency.  ",
          suppressAlertTypes: null,
          suppressSupplierName: null,
          suppressCountryOfOrigin: null,
          suppressHtsPrefix: null,
        },
      ],
    });
    expect(out.startsWith("ERROR:")).toBe(false);
    expect(created[0][0]).toEqual({
      kind: "save_org_rule",
      text: "Always check type 03 entries for AD/CVD consistency.",
      suppression: null,
    });
    expect(events.some((e) => e.type === "proposal")).toBe(true);
  });

  it("builds a normalized suppression spec", async () => {
    const { ctx } = makeCtx();
    const created: AgentProposalPayload[][] = [];
    const deps = makeDeps({
      createProposals: async (payloads) => {
        created.push(payloads);
        return [];
      },
    });
    await tool(deps, ctx, "propose_actions").run({
      actions: [
        {
          kind: "save_org_rule",
          alertId: null,
          decision: null,
          note: null,
          entryId: null,
          reason: null,
          ruleText: "Ignore rate noise on CN drivetrain motors.",
          suppressAlertTypes: ["rate_mismatch", "amount_mismatch"],
          suppressSupplierName: "Shenzhen Drivetrain Co",
          suppressCountryOfOrigin: "cn",
          suppressHtsPrefix: "8501.31",
        },
      ],
    });
    expect(created[0][0]).toEqual({
      kind: "save_org_rule",
      text: "Ignore rate noise on CN drivetrain motors.",
      suppression: {
        alertTypes: ["rate_mismatch", "amount_mismatch"],
        supplierName: "Shenzhen Drivetrain Co",
        countryOfOrigin: "CN",
        htsPrefix: "850131",
      },
    });
  });

  it("rejects a rule without text and scope without alert types", async () => {
    const { ctx } = makeCtx();
    let createCalls = 0;
    const deps = makeDeps({
      createProposals: async () => {
        createCalls += 1;
        return [];
      },
    });
    const base = {
      kind: "save_org_rule" as const,
      alertId: null,
      decision: null,
      note: null,
      entryId: null,
      reason: null,
      suppressAlertTypes: null,
      suppressSupplierName: null,
      suppressCountryOfOrigin: null,
      suppressHtsPrefix: null,
    };
    const noText = await tool(deps, ctx, "propose_actions").run({
      actions: [{ ...base, ruleText: "   " }],
    });
    expect(noText.startsWith("ERROR:")).toBe(true);
    expect(noText).toContain("ruleText");

    const scopeOnly = await tool(deps, ctx, "propose_actions").run({
      actions: [
        {
          ...base,
          ruleText: "Ignore Acme.",
          suppressSupplierName: "Acme",
        },
      ],
    });
    expect(scopeOnly.startsWith("ERROR:")).toBe(true);
    expect(scopeOnly).toContain("suppressAlertTypes");
    expect(createCalls).toBe(0);
  });
});
