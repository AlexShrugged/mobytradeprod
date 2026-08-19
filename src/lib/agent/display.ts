// Display projections over persisted rows: raw Anthropic content blocks ->
// what the thread renders, and proposal rows -> card views. Shared by the
// read query (RSC) and the live stream (message_final / proposal events)
// so both paths render identically. Pure.
//
// Tool chips derive from ONE vocabulary here: describeToolCall labels a call
// from its input, summarizeToolResult labels the outcome from the result
// text, condensedToolLabel names a run of same-tool calls. tools.ts emits
// live events through the same functions, so a chip reads identically while
// streaming and after the refresh swaps in the durable rows.

import { normalizeContentBlocks } from "./transcript";
import type {
  AgentProposalPayload,
  AgentProposalStatus,
  AgentProposalView,
  DisplayBlock,
  DisplayMessage,
} from "./types";

const toIso = (v: Date | string | null): string | null =>
  v === null ? null : typeof v === "string" ? v : v.toISOString();

// ------------------------------------------------------------- tool chips

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec =>
  v !== null && typeof v === "object" ? (v as Rec) : {};
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" ? v : null);

/** One tool call as a chip renders it. ok null = still running (live). */
export type ToolCallView = {
  name: string;
  summary: string;
  result: string | null;
  ok: boolean | null;
};

/** Label a call from its input - the tool_started chip text. */
export function describeToolCall(name: string, input: unknown): string {
  const i = rec(input);
  switch (name) {
    case "get_variance_queue":
      return `Variance queue (${str(i.status) ?? "open"})`;
    case "get_variance_detail":
      return "Variance detail";
    case "search_entries": {
      const q = str(i.q);
      return q ? `Entries matching "${q}"` : "Entries";
    }
    case "get_entry":
      return "Entry detail";
    case "get_expected_charges":
      return `Expected charges, line ${num(i.lineNumber) ?? "?"}`;
    case "get_measures":
      return `Measures for ${str(i.hts) ?? "?"}`;
    case "search_parts": {
      const q = str(i.q);
      return q ? `Parts matching "${q}"` : "Parts";
    }
    case "get_part":
      return `Part ${str(i.sku) ?? "?"}`;
    case "list_documents": {
      const entryNumber = str(i.entryNumber);
      return entryNumber ? `Documents on entry ${entryNumber}` : "Documents";
    }
    case "read_document":
      return "Document extraction";
    case "read_document_text": {
      const page = num(i.page);
      return `Document text${page !== null ? `, page ${page}` : ""}`;
    }
    case "propose_actions": {
      const n = Array.isArray(i.actions) ? i.actions.length : 1;
      return `Proposing ${n} action${n === 1 ? "" : "s"}`;
    }
    default:
      return name;
  }
}

/** Outcome label from the result text a tool returned (the same string the
 *  tool_result block persists). Null summary = nothing worth appending. */
export function summarizeToolResult(
  name: string,
  text: string,
): { ok: boolean; summary: string | null } {
  if (text.startsWith("ERROR:")) {
    return { ok: false, summary: text.slice(0, 120) };
  }
  let payload: Rec;
  try {
    payload = rec(JSON.parse(text));
  } catch {
    // Truncated or non-JSON payloads carry no chip summary.
    return { ok: true, summary: null };
  }
  const counted = (unit: string): string | null => {
    const n = num(payload.matched);
    return n === null ? null : `${n} ${unit}`;
  };
  switch (name) {
    case "get_variance_queue":
      return { ok: true, summary: counted("rows") };
    case "get_variance_detail": {
      const label =
        str(rec(payload.alert).label) ?? str(rec(payload.finding).title);
      return { ok: true, summary: label ? label.slice(0, 80) : null };
    }
    case "search_entries":
      return { ok: true, summary: counted("entries") };
    case "get_entry": {
      const entryNumber = str(payload.entryNumber);
      return { ok: true, summary: entryNumber ? `Entry ${entryNumber}` : null };
    }
    case "search_parts":
      return { ok: true, summary: counted("parts") };
    case "get_part":
      return { ok: true, summary: str(payload.sku) };
    case "list_documents":
      return { ok: true, summary: counted("documents") };
    case "read_document":
    case "read_document_text":
      return { ok: true, summary: str(payload.fileName) };
    case "propose_actions": {
      const created = Array.isArray(payload.created)
        ? payload.created.length
        : 0;
      const errors = Array.isArray(payload.errors) ? payload.errors.length : 0;
      return {
        ok: true,
        summary: `${created} proposed${errors > 0 ? `, ${errors} rejected` : ""}`,
      };
    }
    default:
      return { ok: true, summary: null };
  }
}

/** One chip for a run of same-tool calls: "Read 4 entries". */
export function condensedToolLabel(name: string, count: number): string {
  switch (name) {
    case "get_variance_queue":
      return `Searched variances ×${count}`;
    case "get_variance_detail":
      return `Read ${count} variances`;
    case "search_entries":
      return `Searched entries ×${count}`;
    case "get_entry":
      return `Read ${count} entries`;
    case "get_expected_charges":
      return `Computed charges for ${count} lines`;
    case "get_measures":
      return `Resolved measures ×${count}`;
    case "search_parts":
      return `Searched parts ×${count}`;
    case "get_part":
      return `Read ${count} parts`;
    case "list_documents":
      return `Listed documents ×${count}`;
    case "read_document":
      return `Read ${count} documents`;
    case "read_document_text":
      return `Read document text ×${count}`;
    case "propose_actions":
      return `Proposed actions ×${count}`;
    default:
      return `${name} ×${count}`;
  }
}

/** tool_use id -> result text, harvested from raw persisted rows so the
 *  durable projection can label chips with outcomes. */
export function collectToolResults(
  rows: { content: unknown }[],
): Map<string, string> {
  const map = new Map<string, string>();
  for (const row of rows) {
    for (const block of normalizeContentBlocks(row.content)) {
      if (
        block.type !== "tool_result" ||
        typeof block.tool_use_id !== "string"
      ) {
        continue;
      }
      const content = block.content;
      const text =
        typeof content === "string"
          ? content
          : Array.isArray(content)
            ? content
                .map((c) => {
                  const b = rec(c);
                  return b.type === "text" && typeof b.text === "string"
                    ? b.text
                    : "";
                })
                .join("")
            : "";
      map.set(block.tool_use_id, text);
    }
  }
  return map;
}

/** Null for transcript plumbing rows (pure tool_result messages) - the
 *  thread skips them; tool activity renders from the assistant side.
 *  toolResults (from collectToolResults) lets chips carry outcomes; without
 *  it a tool_use renders as an ok chip with no result. */
export function toDisplayMessage(
  row: {
    id: string;
    seq: number;
    role: string;
    content: unknown;
    createdAt: Date | string;
  },
  toolResults?: ReadonlyMap<string, string>,
): DisplayMessage | null {
  if (row.role !== "user" && row.role !== "assistant") return null;
  const blocks: DisplayBlock[] = [];
  for (const block of normalizeContentBlocks(row.content)) {
    if (block.type === "text" && typeof block.text === "string") {
      if (block.text.trim() !== "") {
        blocks.push({ type: "text", text: block.text });
      }
    } else if (block.type === "tool_use" && typeof block.name === "string") {
      const raw =
        typeof block.id === "string" ? toolResults?.get(block.id) : undefined;
      const finished =
        raw === undefined
          ? { ok: true, summary: null }
          : summarizeToolResult(block.name, raw);
      blocks.push({
        type: "tool_use",
        name: block.name,
        summary: describeToolCall(block.name, block.input),
        result: finished.summary,
        ok: finished.ok,
      });
    }
  }
  if (blocks.length === 0) return null;
  return {
    id: row.id,
    role: row.role,
    seq: row.seq,
    blocks,
    createdAt: toIso(row.createdAt) as string,
  };
}

export function toProposalView(
  row: {
    id: string;
    conversationId: string;
    messageId: string | null;
    kind: string;
    payload: unknown;
    status: string;
    decidedAt: Date | string | null;
    results: unknown;
    createdAt: Date | string;
  },
  liveStatuses: AgentProposalView["liveStatuses"] = null,
): AgentProposalView {
  return {
    id: row.id,
    conversationId: row.conversationId,
    messageId: row.messageId,
    kind: row.kind as AgentProposalPayload["kind"],
    payload: row.payload as AgentProposalPayload,
    status: row.status as AgentProposalStatus,
    decidedAt: toIso(row.decidedAt),
    results: Array.isArray(row.results)
      ? (row.results as { id: string; ok: boolean }[])
      : null,
    createdAt: toIso(row.createdAt) as string,
    liveStatuses,
  };
}
