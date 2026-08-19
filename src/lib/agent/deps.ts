// Production wiring for the assistant tools: binds the org-scoped query
// modules and deterministic engines behind the AgentToolDeps seam. This is
// the module that makes lib/agent request-scoped and server-only - tools.ts
// itself never imports IO, so the fake-deps vitest pattern stays intact.
// createProposals is injected by service.ts (the single writer) to keep the
// import graph acyclic.

import "server-only";

import { and, eq } from "drizzle-orm";

import { loadAuditableSnapshot } from "../audit/auditor";
import { toCents } from "../audit/rules";
import { db, schema } from "../db";
import {
  getDocuments,
  getDocumentsForEntity,
} from "../db/queries/documents";
import { getEntries, getEntryDetail } from "../db/queries/entries";
import { getParts } from "../db/queries/parts";
import { getReferenceDataForOrg } from "../db/queries/reference";
import {
  getAiVarianceDetail,
  getVarianceDetail,
  getVarianceQueue,
} from "../db/queries/variance";
import {
  computeExpectedCharges,
  normalizeHts,
  resolveBaseSchedule,
  resolveExpectedMeasures,
} from "../duty/calculator";
import { resolveSailInfo } from "../duty/sail";
import { getCurrentOrgId } from "../org";
import type {
  AgentDocRow,
  AgentProposalPayload,
  AgentProposalView,
  AgentToolDeps,
} from "./types";

const todayIso = () => new Date().toISOString().slice(0, 10);

const toDocRow = (d: {
  id: string;
  fileName: string;
  docType: string;
  status: string;
  packetRole: string | null;
  pageRange: number[] | null;
  parentDocumentId: string | null;
  uploadedAt: Date | null;
}): AgentDocRow => ({
  id: d.id,
  fileName: d.fileName,
  docType: d.docType,
  status: d.status,
  packetRole: d.packetRole,
  pageRange: d.pageRange,
  parentDocumentId: d.parentDocumentId,
  uploadedAt: d.uploadedAt ? d.uploadedAt.toISOString() : null,
});

export async function buildAgentToolDeps(opts: {
  createProposals: (
    payloads: AgentProposalPayload[],
  ) => Promise<AgentProposalView[]>;
}): Promise<AgentToolDeps> {
  const orgId = await getCurrentOrgId();

  return {
    todayIso,
    getVarianceQueue: () => getVarianceQueue(),
    getVarianceDetail: (alertId) => getVarianceDetail(alertId),
    getAiVarianceDetail: (findingId) => getAiVarianceDetail(findingId),
    searchEntries: ({ q, page }) => getEntries({ page, per: 20, q }),
    getEntryDetail: (entryId) => getEntryDetail(entryId),
    getEntryHeader: async (entryId) => {
      const row = await db.query.entries.findFirst({
        where: and(
          eq(schema.entries.id, entryId),
          eq(schema.entries.orgId, orgId),
        ),
        columns: { id: true, entryNumber: true },
      });
      return row ?? null;
    },
    searchParts: ({ q, per }) => getParts({ page: 1, per, q }),
    listDocuments: () => getDocuments(),
    getDocumentsForEntryNumber: async (entryNumber) => {
      const entry = await db.query.entries.findFirst({
        where: and(
          eq(schema.entries.entryNumber, entryNumber),
          eq(schema.entries.orgId, orgId),
        ),
        columns: { id: true },
      });
      if (!entry) return null;
      const linked = await getDocumentsForEntity("entry", entry.id);
      return linked.map(({ document }) => toDocRow(document));
    },
    getDocumentExtraction: async (documentId) => {
      const doc = await db.query.documents.findFirst({
        where: and(
          eq(schema.documents.id, documentId),
          eq(schema.documents.orgId, orgId),
        ),
        columns: { rawExtraction: false },
      });
      if (!doc) return null;
      return { ...toDocRow(doc), extractedData: doc.extractedData };
    },
    getDocumentRawExtraction: async (documentId) => {
      // The one deliberate raw_extraction read: a single column for a
      // single org-scoped document (multi-MB payload - never listed).
      const doc = await db.query.documents.findFirst({
        where: and(
          eq(schema.documents.id, documentId),
          eq(schema.documents.orgId, orgId),
        ),
        columns: { fileName: true, pageRange: true, rawExtraction: true },
      });
      return doc ?? null;
    },
    getExpectedCharges: async (entryId, lineNumber) => {
      const snapshot = await loadAuditableSnapshot(db, orgId, entryId);
      if (!snapshot) {
        return { ok: false, error: `no entry with id ${entryId}.` };
      }
      const line = snapshot.auditable.lines.find(
        (l) => l.lineNumber === lineNumber,
      );
      if (!line) {
        return {
          ok: false,
          error: `no line ${lineNumber}. Lines: ${snapshot.auditable.lines.map((l) => l.lineNumber).join(", ")}`,
        };
      }
      if (!snapshot.auditable.entryDate) {
        return {
          ok: false,
          error:
            "entry has no entry date - expected charges cannot be date-resolved.",
        };
      }
      const enteredValueCents = toCents(line.enteredValue);
      if (enteredValueCents === null) {
        return {
          ok: false,
          error: `line ${lineNumber} has no parseable entered value.`,
        };
      }
      const ref = await getReferenceDataForOrg();
      return {
        ok: true,
        payload: computeExpectedCharges(
          {
            htsDigits: line.htsCodeDigits,
            countryOfOrigin: line.countryOfOrigin,
            enteredValueCents,
            entryDate: snapshot.auditable.entryDate,
            sail: snapshot.auditable.sail,
          },
          ref,
        ),
      };
    },
    getMeasures: async (hts, countryOfOrigin, date) => {
      const ref = await getReferenceDataForOrg();
      const htsDigits = normalizeHts(hts);
      const resolved = resolveExpectedMeasures(
        {
          htsDigits,
          countryOfOrigin,
          entryDate: date,
          // No shipment context on a counterfactual query - the assumed
          // sail basis, same as an undated entry.
          sail: resolveSailInfo([]),
        },
        ref,
      );
      const base = resolveBaseSchedule(htsDigits, date, ref);
      return {
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
      };
    },
    createProposals: opts.createProposals,
  };
}
