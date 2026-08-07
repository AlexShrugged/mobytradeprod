// Domain knowledge about broker "entry packets" (a.k.a. ACH packets): the
// bundle of documents a customs broker assembles to support one entry filing —
// entry summary (7501), commercial invoice, packing list, transport document,
// certificate of origin, HTS code list. Ported from the legacy platform's
// BrokerEntryPacket module so the vocabulary, role routing, and recognition
// heuristic live in exactly one place. Pure: no IO, no db.
//
// Relative imports: reachable from tsx scripts (seed) where "@/" doesn't
// resolve.

import type { DocumentTypeValue, PacketRoleValue } from "../db/schema";
import type { EntryPacketExtraction, PacketPartExtraction } from "./types";
import { ProcessingError } from "./types";

// Patterns that identify an assist sheet. Assist sheets enumerate statutory
// additions to customs value (tooling, molds, materials the importer
// furnishes) and look columnar like a commercial invoice — the legacy
// platform learned that letting them match the broad /\binvoice\b/ pattern
// turns assist amounts into a bogus Invoice that then produces spurious
// value-mismatch alerts. Named separately so callers can test for it without
// normalizing a full role.
export const ASSIST_SHEET_PATTERNS = [/assist\s*sheet/i, /\bassist\b/i];

// Ordered: the FIRST role whose patterns match the splitter's free-form
// name/title wins. entry_summary_7501 first (the anchor, most specific
// keywords); assist_sheet strictly BEFORE commercial_invoice (see above).
const ROLE_PATTERNS: [PacketRoleValue, RegExp[]][] = [
  [
    "entry_summary_7501",
    [/7501/i, /entry\s*summary/i, /entry\s*tariff\s*code\s*sheet/i],
  ],
  [
    "certificate_of_origin",
    [/certificate\s*of\s*origin/i, /\bcert.*origin/i, /\bco[_\s-]/i],
  ],
  ["packing_list", [/packing\s*list/i, /\bpacking\b/i, /\bpkg\b/i, /\bp\/?l\b/i]],
  ["assist_sheet", ASSIST_SHEET_PATTERNS],
  [
    "commercial_invoice",
    [/commercial\s*invoice/i, /\binvoice\b/i, /\bcdm\b/i, /\binv\b/i],
  ],
  [
    "transport_document",
    [
      /bill\s*of\s*lading/i,
      /\bb\/?l\b/i,
      /waybill/i,
      /\bhawb\b/i,
      /\bmawb\b/i,
      /\bmbol\b/i,
      /telex/i,
      /\btlx\b/i,
      /arrival\s*notice/i,
    ],
  ],
  ["hts_code_list", [/\bhts\b/i, /tariff\s*code/i, /\bhs\s*code/i]],
];

// Normalize a splitter's free-form section name/title into a canonical role.
export function normalizeRole(raw: string | null | undefined): PacketRoleValue {
  const text = (raw ?? "").trim();
  if (!text) return "other";
  for (const [role, patterns] of ROLE_PATTERNS) {
    if (patterns.some((p) => p.test(text))) return role;
  }
  return "other";
}

// The docType a packet child of each role processes as. Roles without a
// dedicated extraction pipeline ("other") still get a child row — the part
// stays visible and downloadable, it just extracts nothing. assist_sheet
// deliberately maps to "other", never commercial_invoice.
const ROLE_TO_DOC_TYPE: Record<PacketRoleValue, DocumentTypeValue> = {
  entry_summary_7501: "port_entry",
  commercial_invoice: "commercial_invoice",
  assist_sheet: "other",
  packing_list: "packing_list",
  transport_document: "shipment",
  certificate_of_origin: "other",
  hts_code_list: "other",
  other: "other",
};

export function roleToDocType(role: PacketRoleValue): DocumentTypeValue {
  return ROLE_TO_DOC_TYPE[role];
}

const ROLE_LABELS: Record<PacketRoleValue, string> = {
  entry_summary_7501: "Entry summary (7501)",
  commercial_invoice: "Commercial invoice",
  assist_sheet: "Assist sheet",
  packing_list: "Packing list",
  transport_document: "Transport document",
  certificate_of_origin: "Certificate of origin",
  hts_code_list: "HTS code list",
  other: "Other",
};

export function packetRoleLabel(role: PacketRoleValue): string {
  return ROLE_LABELS[role];
}

// "p. 3" / "pp. 3–6" for a child's page range within the parent PDF.
export function pageRangeLabel(pages: number[] | null | undefined): string | null {
  if (!pages || pages.length === 0) return null;
  const min = Math.min(...pages);
  const max = Math.max(...pages);
  return min === max ? `p. ${min}` : `pp. ${min}–${max}`;
}

// Heuristic for whether a split PDF is a broker entry packet, given the
// splitter's per-part name/title guesses and the source filename.
export function isEntryPacket(
  rawTypes: string[],
  fileName?: string | null,
): boolean {
  const roles = rawTypes.map((t) => normalizeRole(t));
  // A 7501 is the strongest signal.
  if (roles.includes("entry_summary_7501")) return true;
  // Brokers name these packets explicitly ("ACH PACKET-...").
  if (/ach[\s_-]*packet/i.test(fileName ?? "")) return true;
  // Otherwise require an invoice plus at least one other supporting doc.
  return (
    roles.includes("commercial_invoice") &&
    roles.some(
      (r) =>
        r === "transport_document" ||
        r === "packing_list" ||
        r === "certificate_of_origin",
    )
  );
}

// The provider-agnostic shape of one split section. Reducto's SplitResponse
// carries pages as numbers; its DeepSplitResult variant as { page_number }.
export type RawSplitPart = {
  name: string | null | undefined;
  pages: (number | { page_number?: number | null } | null | undefined)[];
  conf?: string | null;
};

// Map a provider split response into the packet manifest. Parts with no
// usable pages are dropped; zero usable parts is a processing failure (a
// packet whose split found nothing cannot produce children).
export function mapSplitToManifest(parts: RawSplitPart[]): EntryPacketExtraction {
  const usable = parts
    .map((part) => {
      const pages = [
        ...new Set(
          part.pages
            .map((p) =>
              typeof p === "number" ? p : (p?.page_number ?? null),
            )
            .filter((p): p is number => typeof p === "number" && p >= 1),
        ),
      ].sort((a, b) => a - b);
      if (pages.length === 0) return null;
      const role = normalizeRole(part.name);
      return {
        role,
        doc_type: roleToDocType(role),
        title: part.name?.trim() || null,
        pages,
        confidence:
          part.conf === "high" || part.conf === "low" ? part.conf : null,
      };
    })
    .filter((p): p is Omit<PacketPartExtraction, "part_index"> => p !== null)
    // Deterministic manifest order: by first page.
    .sort((a, b) => a.pages[0] - b.pages[0]);

  if (usable.length === 0) {
    throw new ProcessingError(
      "Packet split produced no usable parts — nothing to process.",
    );
  }
  return {
    parts: usable.map((p, i) => ({ part_index: i + 1, ...p })),
  };
}

// Processing order for a packet's children: 7501s first (they create the
// entries), then commercial invoices (they link to those entries), then the
// rest. Stable within a tier (manifest order).
const ROLE_PROCESSING_TIER: Partial<Record<PacketRoleValue, number>> = {
  entry_summary_7501: 0,
  commercial_invoice: 1,
};

export function orderPacketParts(
  parts: PacketPartExtraction[],
): PacketPartExtraction[] {
  return [...parts].sort(
    (a, b) =>
      (ROLE_PROCESSING_TIER[a.role] ?? 2) - (ROLE_PROCESSING_TIER[b.role] ?? 2) ||
      a.part_index - b.part_index,
  );
}

// Deterministic child file name: "<parent stem> — <role> (pp. 3–4).pdf".
// Purely presentational (children share the parent's bytes), but stable so
// reprocessing a packet recreates identically-named children.
export function childFileName(
  parentFileName: string,
  part: PacketPartExtraction,
): string {
  const dot = parentFileName.lastIndexOf(".");
  const stem = dot > 0 ? parentFileName.slice(0, dot) : parentFileName;
  const ext = dot > 0 ? parentFileName.slice(dot) : "";
  return `${stem} — ${packetRoleLabel(part.role)} (${pageRangeLabel(part.pages)})${ext}`;
}
