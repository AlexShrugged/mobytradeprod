// Shared shapes for the org-facing assistant (/assistant): the NDJSON turn
// protocol, proposal payloads, display projections, and the injectable
// seams (tool deps + SDK client slice).
//
// DELIBERATE DEPARTURE from the analyst's zero-IO doctrine: an org-wide
// conversation cannot preload everything it might touch, so assistant tools
// do request-scoped IO through AgentToolDeps. deps.ts (server-only) binds
// the real queries; tests pass fakes. Everything else in this module is
// types only — value imports stay out so pure submodules test cleanly.

import type { DocumentWithSource } from "../db/queries/documents";
import type { EntriesPageResult, EntryDetail } from "../db/queries/entries";
import type { PartsPageResult } from "../db/queries/parts";
import type {
  AiVarianceDetail,
  VarianceDetail,
  VarianceQueueRow,
} from "../db/queries/variance";

// ------------------------------------------------------------- proposals

/** A variance decision awaiting human confirmation. unitIds carry the whole
 *  decidable unit (a rate mismatch plus its amount twin), expanded at
 *  propose time — the confirm PATCHes every id. */
export type AlertDecisionPayload = {
  kind: "alert_decision";
  targetId: string;
  unitIds: string[];
  decision: "resolved" | "dismissed" | "open";
  /** The agent's rationale — lands on the rows as resolutionNote. */
  note: string;
  entryId: string;
  entryNumber: string;
  label: string;
  impactCents: number | null;
  href: string;
};

export type AnalyzeEntryPayload = {
  kind: "analyze_entry";
  entryId: string;
  entryNumber: string;
  reason: string;
};

export type AgentProposalPayload = AlertDecisionPayload | AnalyzeEntryPayload;

export type AgentProposalStatus = "proposed" | "confirmed" | "dismissed";

/** The card as the client renders it — from stream events while a turn is
 *  live, from the read query afterwards. */
export type AgentProposalView = {
  id: string;
  conversationId: string;
  messageId: string | null;
  kind: AgentProposalPayload["kind"];
  payload: AgentProposalPayload;
  status: AgentProposalStatus;
  decidedAt: string | null;
  results: { id: string; ok: boolean }[] | null;
  createdAt: string;
  /** Live status per unit row at read time — surfaces a card gone stale
   *  because the variance was decided elsewhere. Null in stream events. */
  liveStatuses: Record<string, "open" | "resolved" | "dismissed"> | null;
};

// --------------------------------------------------------------- display

export type DisplayBlock =
  | { type: "text"; text: string }
  | {
      type: "tool_use";
      name: string;
      /** Chip label from the call's input ("Entries matching \"China\""). */
      summary: string;
      /** Outcome label from the persisted tool_result ("11 entries"). */
      result: string | null;
      ok: boolean;
    };

export type DisplayMessage = {
  id: string;
  role: "user" | "assistant";
  seq: number;
  blocks: DisplayBlock[];
  createdAt: string;
};

// -------------------------------------------------------------- protocol

export type AgentUsage = {
  iterations: number;
  inputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  outputTokens: number;
};

/** One NDJSON line each. text_delta streams the assistant's prose;
 *  message_final replays the persisted message (the client reconciles the
 *  deltas against it); title lands once on a conversation's first turn
 *  (model-generated, already persisted); turn_done is the terminal event,
 *  error included. */
export type AgentEvent =
  | { type: "turn_started"; userMessageId: string }
  | { type: "text_delta"; delta: string }
  | { type: "title"; title: string }
  | { type: "tool_started"; callId: number; name: string; summary: string }
  | {
      type: "tool_finished";
      callId: number;
      name: string;
      ok: boolean;
      summary: string;
    }
  | { type: "proposal"; proposal: AgentProposalView }
  | { type: "message_final"; message: DisplayMessage }
  | { type: "turn_done"; usage: AgentUsage }
  | { type: "error"; message: string }
  | { type: "heartbeat" };

export type AgentTurnSink = { emit(event: AgentEvent): void };

/** One tool invocation, recorded for observability (same shape as the
 *  analyst's trace). */
export type ToolTraceEntry = {
  tool: string;
  input: unknown;
  resultPreview: string;
};

export type AgentToolCtx = {
  trace: ToolTraceEntry[];
  sink: AgentTurnSink;
  /** Proposal ids created since the last assistant message persisted —
   *  drained by the runner to anchor cards to their message. */
  pendingProposalIds: string[];
  /** Set by respond() for the tool_finished chip ("12 rows"). */
  lastToolSummary: string | null;
};

// ------------------------------------------------------------- tool deps

/** Compact document row shared by both listing paths. */
export type AgentDocRow = {
  id: string;
  fileName: string;
  docType: string;
  status: string;
  packetRole: string | null;
  pageRange: number[] | null;
  parentDocumentId: string | null;
  uploadedAt: string | null;
};

export type ExpectedChargesResult =
  | { ok: true; payload: unknown }
  | { ok: false; error: string };

export type AgentToolDeps = {
  todayIso(): string;
  getVarianceQueue(): Promise<VarianceQueueRow[]>;
  getVarianceDetail(alertId: string): Promise<VarianceDetail | null>;
  getAiVarianceDetail(findingId: string): Promise<AiVarianceDetail | null>;
  searchEntries(opts: {
    q: string | null;
    page: number;
  }): Promise<EntriesPageResult>;
  getEntryDetail(entryId: string): Promise<EntryDetail | null>;
  getEntryHeader(
    entryId: string,
  ): Promise<{ id: string; entryNumber: string } | null>;
  searchParts(opts: { q: string | null; per: number }): Promise<PartsPageResult>;
  listDocuments(): Promise<DocumentWithSource[]>;
  /** Null when no entry with that number exists in the org. */
  getDocumentsForEntryNumber(
    entryNumber: string,
  ): Promise<AgentDocRow[] | null>;
  getDocumentExtraction(documentId: string): Promise<
    | (AgentDocRow & { extractedData: unknown })
    | null
  >;
  /** The only deliberate raw_extraction reader — one column, one document. */
  getDocumentRawExtraction(documentId: string): Promise<{
    fileName: string;
    pageRange: number[] | null;
    rawExtraction: unknown;
  } | null>;
  getExpectedCharges(
    entryId: string,
    lineNumber: number,
  ): Promise<ExpectedChargesResult>;
  getMeasures(
    hts: string,
    countryOfOrigin: string | null,
    date: string,
  ): Promise<unknown>;
  createProposals(
    payloads: AgentProposalPayload[],
  ): Promise<AgentProposalView[]>;
};

// ---------------------------------------------------------------- runner

/** The slice of the SDK client the assistant uses — injectable for tests
 *  (analyst precedent: structural typing, no module mocking). stream: true
 *  makes the runner yield one message stream per iteration. */
export type RunnerFinalMessage = {
  stop_reason: string | null;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number | null;
    cache_creation_input_tokens?: number | null;
  };
};

export type RunnerStreamLike = {
  on(event: "text", listener: (delta: string) => void): unknown;
  finalMessage(): Promise<RunnerFinalMessage>;
};

export interface AgentClient {
  messages: {
    /** Single non-streaming call - the title generator. */
    create(
      params: Record<string, unknown>,
      opts?: { signal?: AbortSignal },
    ): Promise<{ content: { type: string; text?: string }[] }>;
  };
  beta: {
    messages: {
      toolRunner(
        params: Record<string, unknown>,
        opts?: { signal?: AbortSignal },
      ): AsyncIterable<RunnerStreamLike> & {
        params: { messages: unknown[] };
      };
    };
  };
}

export type PersistedMessageRef = {
  id: string;
  seq: number;
  role: string;
  content: unknown;
  createdAt: Date | string;
};

export type AgentTurnInput = {
  system: string;
  /** The rebuilt wire transcript, latest user message included. The runner
   *  appends to this array as the turn progresses. */
  messages: unknown[];
  /** BetaRunnableTool[] — typed loosely so pure modules stay SDK-free. */
  tools: { name: string; run: (input: never) => unknown }[];
  sink: AgentTurnSink;
  signal: AbortSignal;
  /** Persist wire messages appended past the baseline, in order. */
  persistNewMessages(
    msgs: { role: string; content: unknown }[],
  ): Promise<PersistedMessageRef[]>;
  /** Anchor proposals created mid-iteration to their persisted message. */
  attachProposals(proposalIds: string[], messageId: string): Promise<void>;
  /** Shared with the tool ctx — see AgentToolCtx.pendingProposalIds. */
  pendingProposalIds: string[];
};

export type AgentTurnResult = {
  usage: AgentUsage;
  /** Set when the turn degraded (deadline, refusal, API error). Persisted
   *  messages stand; the conversation stays usable. Never a thrown error. */
  error: string | null;
};

export interface AgentRunner {
  readonly model: string;
  runTurn(input: AgentTurnInput): Promise<AgentTurnResult>;
  /** Title a new conversation from its first user message. Null keeps the
   *  derived fallback (stub, failure, refusal). Never throws. */
  generateTitle(userText: string): Promise<string | null>;
}
