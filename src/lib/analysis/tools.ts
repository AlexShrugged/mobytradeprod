// The analyst's tool surface: nine betaZodTools closed over a preloaded
// ToolContext — zero IO inside a tool, so every call is cheap, deterministic,
// and testable without a database. Tools return JSON strings (capped) or
// "ERROR: ..." strings the model can self-correct from; report_findings is
// the terminal action that fills the collector.
//
// Relative imports on purpose — this module runs under the tsx eval script.

import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { BetaRunnableTool } from "@anthropic-ai/sdk/lib/tools/BetaRunnableTool";
import { z } from "zod";

import { computeEntryAlerts, toCents } from "../audit/rules";
import { applySuppressions } from "../audit/suppression";
import {
  computeExpectedCharges,
  normalizeHts,
  resolveBaseSchedule,
  resolveExpectedMeasures,
} from "../duty/calculator";
import type { ReferenceData } from "../duty/types";
import type { SuppressionSpec } from "../org-rules";
import { findingsReportSchema, type FindingsReport } from "./findings";
import { resolveRegulatoryParams } from "./regulatory-params";
import type { EntryBundle, ToolTraceEntry } from "./types";

export type ToolContext = {
  bundle: EntryBundle;
  ref: ReferenceData;
  trace: ToolTraceEntry[];
};

export type ReportCollector = { report: FindingsReport | null };

const MAX_RESULT_CHARS = 24_000;

function respond(
  ctx: ToolContext,
  tool: string,
  input: unknown,
  payload: unknown,
): string {
  const text = typeof payload === "string" ? payload : JSON.stringify(payload);
  const capped =
    text.length > MAX_RESULT_CHARS
      ? `${text.slice(0, MAX_RESULT_CHARS)}\n[truncated ${text.length - MAX_RESULT_CHARS} chars — narrow the request]`
      : text;
  ctx.trace.push({ tool, input, resultPreview: capped.slice(0, 300) });
  return capped;
}

export function buildAnalystTools(
  ctx: ToolContext,
  collector: ReportCollector,
): BetaRunnableTool[] {
  const { bundle, ref } = ctx;
  const { auditable, entry } = bundle.snapshot;

  const readDocument = betaZodTool({
    name: "read_document",
    description:
      "Read one linked document's typed extraction (the parsed fields of the 7501, commercial invoice, BOL, packet child, etc.). Use the document ids from the document list in your briefing.",
    inputSchema: z.object({ documentId: z.string() }),
    run: (input) => {
      const doc = bundle.documents.find((d) => d.id === input.documentId);
      if (!doc) {
        return respond(
          ctx,
          "read_document",
          input,
          `ERROR: no linked document with id ${input.documentId}. Available ids: ${bundle.documents.map((d) => d.id).join(", ")}`,
        );
      }
      return respond(ctx, "read_document", input, {
        id: doc.id,
        fileName: doc.fileName,
        docType: doc.docType,
        status: doc.status,
        packetRole: doc.packetRole,
        pageRange: doc.pageRange,
        extractedData: doc.extractedData,
      });
    },
  });

  const getExpectedCharges = betaZodTool({
    name: "get_expected_charges",
    description:
      "Compute the deterministic expected charges for one entry line (base duty + applicable Chapter 99 measures with stacking, date- and sail-resolved). This is the source of truth for duty math — cite it, never recompute rates yourself. MPF/HMF are never included (they are ingested facts; check them against get_regulatory_params).",
    inputSchema: z.object({ lineNumber: z.number() }),
    run: (input) => {
      const line = auditable.lines.find(
        (l) => l.lineNumber === input.lineNumber,
      );
      if (!line) {
        return respond(
          ctx,
          "get_expected_charges",
          input,
          `ERROR: no line ${input.lineNumber}. Lines: ${auditable.lines.map((l) => l.lineNumber).join(", ")}`,
        );
      }
      if (!auditable.entryDate) {
        return respond(
          ctx,
          "get_expected_charges",
          input,
          "ERROR: entry has no entry date — expected charges cannot be date-resolved.",
        );
      }
      const enteredValueCents = toCents(line.enteredValue);
      if (enteredValueCents === null) {
        return respond(
          ctx,
          "get_expected_charges",
          input,
          `ERROR: line ${input.lineNumber} has no parseable entered value.`,
        );
      }
      const expected = computeExpectedCharges(
        {
          htsDigits: line.htsCodeDigits,
          countryOfOrigin: line.countryOfOrigin,
          enteredValueCents,
          entryDate: auditable.entryDate,
          sail: auditable.sail,
        },
        ref,
      );
      return respond(ctx, "get_expected_charges", input, expected);
    },
  });

  const getMeasures = betaZodTool({
    name: "get_measures",
    description:
      "Resolve which tariff measures (and base-schedule rate) apply to an arbitrary HTS code + country of origin as of a date — the counterfactual tool ('what would this code from CN owe?'). date null = this entry's date.",
    inputSchema: z.object({
      hts: z.string(),
      countryOfOrigin: z.string().nullable(),
      date: z.string().nullable(),
    }),
    run: (input) => {
      const date = input.date ?? auditable.entryDate;
      if (!date) {
        return respond(
          ctx,
          "get_measures",
          input,
          "ERROR: no date given and the entry has no entry date.",
        );
      }
      const htsDigits = normalizeHts(input.hts);
      const resolved = resolveExpectedMeasures(
        {
          htsDigits,
          countryOfOrigin: input.countryOfOrigin,
          entryDate: date,
          sail: auditable.sail,
        },
        ref,
      );
      const base = resolveBaseSchedule(htsDigits, date, ref);
      return respond(ctx, "get_measures", input, {
        htsDigits,
        baseSchedule: base
          ? {
              code: base.code,
              description: base.description,
              rateType: base.rateType,
              rate: base.rate,
            }
          : null,
        applicable: resolved.applicable,
        suppressed: resolved.suppressed,
        sailBasis: resolved.sailBasis,
      });
    },
  });

  const getPart = betaZodTool({
    name: "get_part",
    description:
      "Look up a SKU in the parts catalog: name, description, current + historical HTS classification windows, and per-vendor sourcing facts (COO, cost, validity windows). An unknown SKU is an error — and a signal the line matched no catalog part.",
    inputSchema: z.object({ sku: z.string() }),
    run: (input) => {
      const part = bundle.partsBySku.get(input.sku);
      if (!part) {
        return respond(
          ctx,
          "get_part",
          input,
          `ERROR: no part with SKU ${input.sku} on this entry's lines.`,
        );
      }
      return respond(ctx, "get_part", input, part);
    },
  });

  const getSiblingEntries = betaZodTool({
    name: "get_sibling_entries",
    description:
      "Other entries moving on this entry's shipments (same bill of lading / air waybill), with their declared lines and charges. Identical goods on one shipment should carry identical Chapter 99 treatment — use this to check cross-entry consistency. An empty list means no sibling entries are known.",
    inputSchema: z.object({}),
    run: (input) =>
      respond(ctx, "get_sibling_entries", input, bundle.siblingEntries),
  });

  const getDeterministicFindings = betaZodTool({
    name: "get_deterministic_findings",
    description:
      "Run the deterministic audit rules over this entry (the same pass production runs) and return the desired alerts. Reconcile these into your findings' relatedAlertKeys — corroborate or contextualize them, don't re-derive them. An alert with a non-null suppressedByRule is hidden from the variance queue by that org rule: do not restate it as a finding, but do weigh what it shows when evidence points at a material, non-routine problem.",
    inputSchema: z.object({}),
    run: (input) => {
      // Unsuppressed output WITH attribution: hiding data from an
      // investigator creates blind spots — the analyst should notice when a
      // rule conceals something material; the annotation plus the prompt
      // doctrine keeps it from re-reporting routine suppressed noise.
      const computed = computeEntryAlerts(auditable, ref);
      const { suppressed } = applySuppressions(
        computed,
        auditable,
        bundle.orgRules
          .filter((r) => r.suppression != null)
          .map((r) => ({
            id: r.id,
            text: r.text,
            suppression: r.suppression as SuppressionSpec,
          })),
      );
      const ruleTextByKey = new Map(
        suppressed.map((s) => [s.alert.alertKey, s.ruleText]),
      );
      const alerts = computed.map((a) => ({
        alertKey: a.alertKey,
        alertType: a.alertType,
        severity: a.severity,
        label: a.label,
        message: a.message,
        details: a.details,
        suppressedByRule: ruleTextByKey.get(a.alertKey) ?? null,
      }));
      return respond(ctx, "get_deterministic_findings", input, alerts);
    },
  });

  const getRegulatoryParams = betaZodTool({
    name: "get_regulatory_params",
    description:
      "Statutory fee parameters in force on a date (MPF ad valorem rate + per-entry minimum/maximum in cents, HMF rate — HMF has no min/max), with the Federal Register citation. date null = this entry's date. Use this to check the declared mpfAmount/hmfAmount on the entry header.",
    inputSchema: z.object({ date: z.string().nullable() }),
    run: (input) => {
      const date = input.date ?? auditable.entryDate;
      if (!date) {
        return respond(
          ctx,
          "get_regulatory_params",
          input,
          "ERROR: no date given and the entry has no entry date.",
        );
      }
      const params = resolveRegulatoryParams(date);
      if (!params) {
        return respond(
          ctx,
          "get_regulatory_params",
          input,
          `ERROR: no regulatory parameters known for ${date} (earliest known window starts 2024-10-01).`,
        );
      }
      return respond(ctx, "get_regulatory_params", input, {
        ...params,
        declaredOnThisEntry: {
          mpfAmount: entry.mpfAmount,
          hmfAmount: entry.hmfAmount,
        },
      });
    },
  });

  const getAdcvdOrders = betaZodTool({
    name: "get_adcvd_orders",
    description:
      "Search the AD/CVD order corpus by case number, country of origin, and/or HTS prefix (all filters optional and AND-ed; no filters returns the whole corpus). Scope summaries and cash-deposit rates are indicative context — scope language governs, so treat membership as a signal to investigate, not a verdict. Use this to adjudicate case numbers on type-03 entries: which order covers the goods, whether the deposit rate matches a producer or all-others rate, and whether a companion AD/CVD order is missing from the declared charges.",
    inputSchema: z.object({
      caseNumber: z.string().nullable(),
      countryOfOrigin: z.string().nullable(),
      htsPrefix: z.string().nullable(),
    }),
    run: (input) => {
      const digits = (s: string) => s.replace(/\D/g, "");
      let orders = bundle.adcvdOrders;
      if (input.caseNumber) {
        const wanted = input.caseNumber.trim().toUpperCase();
        orders = orders.filter((o) => o.caseNumber.toUpperCase() === wanted);
      }
      if (input.countryOfOrigin) {
        const wanted = input.countryOfOrigin.trim().toUpperCase();
        orders = orders.filter((o) => o.country === wanted);
      }
      if (input.htsPrefix) {
        const wanted = digits(input.htsPrefix);
        orders = orders.filter((o) =>
          o.htsPrefixes.some((p) => {
            const pd = digits(p);
            return pd.startsWith(wanted) || wanted.startsWith(pd);
          }),
        );
      }
      if (orders.length === 0) {
        return respond(
          ctx,
          "get_adcvd_orders",
          input,
          `No matching order. Known case numbers: ${bundle.adcvdOrders.map((o) => o.caseNumber).join(", ")}. This corpus is incomplete, so an empty lookup is inconclusive, never evidence: do not treat a declared case number as invalid because it is absent here, and never report the inability to verify as a finding. Report an AD/CVD finding only when the entry's own documents, charges, or case numbers actually conflict.`,
        );
      }
      return respond(ctx, "get_adcvd_orders", input, orders);
    },
  });

  const reportFindings = betaZodTool({
    name: "report_findings",
    description:
      "Submit your final structured findings report. Call this exactly once, as your last action, after your investigation is complete. Every finding must carry evidence with verbatim quotes (and documentIds for document-sourced evidence).",
    inputSchema: findingsReportSchema,
    run: (input) => {
      collector.report = input;
      ctx.trace.push({
        tool: "report_findings",
        input: { findings: input.findings.length },
        resultPreview: "recorded",
      });
      return "Findings recorded. End your turn.";
    },
  });

  return [
    readDocument,
    getExpectedCharges,
    getMeasures,
    getPart,
    getSiblingEntries,
    getDeterministicFindings,
    getRegulatoryParams,
    getAdcvdOrders,
    reportFindings,
  ];
}
