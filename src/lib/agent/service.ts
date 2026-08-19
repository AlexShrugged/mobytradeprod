// Single writer of agent_conversations, agent_messages, and
// agent_proposals. A turn: claim the soft lock, persist the user message,
// rebuild the wire transcript, run the selected agent (which persists its
// output incrementally through the callbacks here), then settle the
// conversation row and release the lock - errors included, so a crashed
// turn never wedges the thread. The proposals PATCH route records the
// human's confirm/dismiss through decideProposal.

import "server-only";

import { and, asc, eq, inArray, isNull, lt, or } from "drizzle-orm";

import { db, schema } from "../db";
import { getCurrentOrg, getCurrentActorName, getCurrentOrgId } from "../org";
import type { AgentConversation, AgentProposal } from "../db/schema";
import { DEADLINE_MS, LOCK_GRACE_MS, deriveTitle } from "./conversation";
import { buildAgentToolDeps } from "./deps";
import { toProposalView } from "./display";
import { buildSystemPrompt } from "./prompt";
import { buildAgentTools } from "./tools";
import {
  appendUserMessage,
  normalizeContentBlocks,
  rebuildMessages,
} from "./transcript";
import type {
  AgentProposalPayload,
  AgentProposalView,
  AgentRunner,
  AgentToolCtx,
  AgentTurnInput,
  AgentTurnSink,
  PersistedMessageRef,
} from "./types";

export class TurnInFlightError extends Error {}
export class ProposalStateError extends Error {}

export async function createConversation(): Promise<AgentConversation> {
  const orgId = await getCurrentOrgId();
  // Outside any transaction (PGlite single-session rule).
  const actor = await getCurrentActorName();
  const [row] = await db
    .insert(schema.agentConversations)
    .values({ orgId, createdByName: actor })
    .returning();
  return row;
}

/** Guarded claim: one turn per conversation. Stale locks (deadline + grace
 *  behind) are reclaimed so a crashed turn heals on the next send. */
export async function claimTurn(conversationId: string): Promise<void> {
  const cutoff = new Date(Date.now() - DEADLINE_MS - LOCK_GRACE_MS);
  const claimed = await db
    .update(schema.agentConversations)
    .set({ turnStartedAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(schema.agentConversations.id, conversationId),
        or(
          isNull(schema.agentConversations.turnStartedAt),
          lt(schema.agentConversations.turnStartedAt, cutoff),
        ),
      ),
    )
    .returning({ id: schema.agentConversations.id });
  if (claimed.length === 0) {
    throw new TurnInFlightError(
      "A turn is already running in this conversation.",
    );
  }
}

export async function createProposals(
  conversationId: string,
  payloads: AgentProposalPayload[],
): Promise<AgentProposalView[]> {
  const orgId = await getCurrentOrgId();
  const rows = await db
    .insert(schema.agentProposals)
    .values(
      payloads.map((payload) => ({
        orgId,
        conversationId,
        kind: payload.kind,
        payload,
      })),
    )
    .returning();
  return rows.map((r) => toProposalView(r));
}

/** Record the human's call on a card. Returns null when the proposal does
 *  not exist in this org (route 404); throws ProposalStateError when it is
 *  no longer "proposed" (route 409). */
export async function decideProposal(
  proposalId: string,
  input: {
    status: "confirmed" | "dismissed";
    results: { id: string; ok: boolean }[] | null;
  },
): Promise<AgentProposal | null> {
  const orgId = await getCurrentOrgId();
  const [row] = await db
    .update(schema.agentProposals)
    .set({
      status: input.status,
      decidedAt: new Date(),
      results: input.results,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(schema.agentProposals.id, proposalId),
        eq(schema.agentProposals.orgId, orgId),
        eq(schema.agentProposals.status, "proposed"),
      ),
    )
    .returning();
  if (row) return row;
  const existing = await db.query.agentProposals.findFirst({
    where: and(
      eq(schema.agentProposals.id, proposalId),
      eq(schema.agentProposals.orgId, orgId),
    ),
  });
  if (!existing) return null;
  throw new ProposalStateError(`Proposal is already ${existing.status}.`);
}

/** Run one turn end to end, emitting protocol events into the sink. Never
 *  throws once the stream is live - failures become error events and the
 *  lock always releases. The caller claims the lock first (claimTurn). */
export async function runTurn(opts: {
  conversation: AgentConversation;
  userText: string;
  sink: AgentTurnSink;
  signal: AbortSignal;
  agent: AgentRunner;
}): Promise<void> {
  const { conversation, sink } = opts;
  const conversationId = conversation.id;
  // First-turn title generation, raced against the turn itself. Settles
  // internally (never rejects) so both exit paths can await it before
  // turn_done.
  let titleWork: Promise<void> | null = null;
  try {
    // Outside any transaction (PGlite single-session rule).
    const org = await getCurrentOrg();

    const priorRows = await db.query.agentMessages.findMany({
      where: eq(schema.agentMessages.conversationId, conversationId),
      orderBy: [asc(schema.agentMessages.seq)],
    });
    let nextSeq = (priorRows[priorRows.length - 1]?.seq ?? 0) + 1;

    const [userRow] = await db
      .insert(schema.agentMessages)
      .values({
        orgId: conversation.orgId,
        conversationId,
        seq: nextSeq++,
        role: "user",
        content: [{ type: "text", text: opts.userText }],
      })
      .returning();
    sink.emit({ type: "turn_started", userMessageId: userRow.id });

    if (priorRows.length === 0) {
      // Derived fallback lands immediately; the model's title (raced with
      // the turn below) overwrites it and streams to the client when ready.
      await db
        .update(schema.agentConversations)
        .set({ title: deriveTitle(opts.userText), updatedAt: new Date() })
        .where(eq(schema.agentConversations.id, conversationId));
      titleWork = (async () => {
        try {
          const generated = await opts.agent.generateTitle(opts.userText);
          if (!generated) return;
          await db
            .update(schema.agentConversations)
            .set({ title: generated, updatedAt: new Date() })
            .where(eq(schema.agentConversations.id, conversationId));
          sink.emit({ type: "title", title: generated });
        } catch (e) {
          console.error("assistant title update failed:", e);
        }
      })();
    }

    const wire = appendUserMessage(rebuildMessages(priorRows), opts.userText);

    const pendingProposalIds: string[] = [];
    const ctx: AgentToolCtx = {
      trace: [],
      sink,
      pendingProposalIds,
      lastToolSummary: null,
    };
    const deps = await buildAgentToolDeps({
      createProposals: (payloads) =>
        createProposals(conversationId, payloads),
    });
    const tools = buildAgentTools(deps, ctx);

    const persistNewMessages = async (
      msgs: { role: string; content: unknown }[],
    ): Promise<PersistedMessageRef[]> => {
      if (msgs.length === 0) return [];
      const rows = await db
        .insert(schema.agentMessages)
        .values(
          msgs.map((m) => ({
            orgId: conversation.orgId,
            conversationId,
            seq: nextSeq++,
            role: m.role === "assistant" ? "assistant" : "user",
            content: normalizeContentBlocks(m.content),
          })),
        )
        .returning();
      rows.sort((a, b) => a.seq - b.seq);
      return rows;
    };

    const attachProposals = async (ids: string[], messageId: string) => {
      if (ids.length === 0) return;
      await db
        .update(schema.agentProposals)
        .set({ messageId, updatedAt: new Date() })
        .where(
          and(
            inArray(schema.agentProposals.id, ids),
            eq(schema.agentProposals.conversationId, conversationId),
          ),
        );
    };

    const result = await opts.agent.runTurn({
      system: buildSystemPrompt({
        orgName: org.name,
        todayIso: new Date().toISOString().slice(0, 10),
      }),
      messages: wire,
      tools: tools as unknown as AgentTurnInput["tools"],
      sink,
      signal: opts.signal,
      persistNewMessages,
      attachProposals,
      pendingProposalIds,
    });

    if (titleWork) await titleWork;

    if (result.error) {
      sink.emit({ type: "error", message: result.error });
    }
    await db
      .update(schema.agentConversations)
      .set({
        turnStartedAt: null,
        lastTurnAt: new Date(),
        lastUsage: result.usage,
        updatedAt: new Date(),
      })
      .where(eq(schema.agentConversations.id, conversationId));
    sink.emit({ type: "turn_done", usage: result.usage });
  } catch (e) {
    // The stream is already flowing - report and release, never throw.
    console.error("assistant turn failed:", e);
    if (titleWork) await titleWork;
    sink.emit({
      type: "error",
      message: e instanceof Error ? e.message : "The turn failed.",
    });
    try {
      await db
        .update(schema.agentConversations)
        .set({ turnStartedAt: null, updatedAt: new Date() })
        .where(eq(schema.agentConversations.id, conversationId));
    } catch (release) {
      console.error("assistant lock release failed:", release);
    }
    sink.emit({
      type: "turn_done",
      usage: {
        iterations: 0,
        inputTokens: 0,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        outputTokens: 0,
      },
    });
  }
}
