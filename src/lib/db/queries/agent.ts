import "server-only";

import { and, asc, desc, eq, inArray } from "drizzle-orm";

import { lockIsStale } from "@/lib/agent/conversation";
import {
  collectToolResults,
  toDisplayMessage,
  toProposalView,
} from "@/lib/agent/display";
import type {
  AgentProposalView,
  AlertDecisionPayload,
  DisplayMessage,
} from "@/lib/agent/types";
import { db, schema } from "@/lib/db";
import type { AgentConversation } from "@/lib/db/schema";
import { getCurrentOrgId } from "@/lib/org";

// Read-only projections for the /assistant pages. Raw transcript rows
// project to display messages here (tool_result plumbing rows drop out);
// proposal cards join the LIVE status of their unit rows so a card decided
// elsewhere renders stale instead of misleading.

export async function getAgentConversations(): Promise<AgentConversation[]> {
  const orgId = await getCurrentOrgId();
  return db.query.agentConversations.findMany({
    where: eq(schema.agentConversations.orgId, orgId),
    orderBy: [desc(schema.agentConversations.updatedAt)],
    limit: 50,
  });
}

export type AgentThread = {
  conversation: AgentConversation;
  messages: DisplayMessage[];
  proposals: AgentProposalView[];
  /** A turn is streaming right now (fresh lock) - the client shows the
   *  in-flight state instead of the composer until it settles. */
  turnInFlight: boolean;
};

export async function getAgentThread(
  conversationId: string,
): Promise<AgentThread | null> {
  const orgId = await getCurrentOrgId();
  const conversation = await db.query.agentConversations.findFirst({
    where: and(
      eq(schema.agentConversations.id, conversationId),
      eq(schema.agentConversations.orgId, orgId),
    ),
  });
  if (!conversation) return null;

  const [messageRows, proposalRows] = await Promise.all([
    db.query.agentMessages.findMany({
      where: eq(schema.agentMessages.conversationId, conversationId),
      orderBy: [asc(schema.agentMessages.seq)],
    }),
    db.query.agentProposals.findMany({
      where: eq(schema.agentProposals.conversationId, conversationId),
      orderBy: [asc(schema.agentProposals.createdAt)],
    }),
  ]);

  const unitIds = new Set<string>();
  for (const p of proposalRows) {
    if (p.kind !== "alert_decision") continue;
    for (const id of (p.payload as AlertDecisionPayload).unitIds) {
      unitIds.add(id);
    }
  }
  const statusById = new Map<string, "open" | "resolved" | "dismissed">();
  if (unitIds.size > 0) {
    const ids = [...unitIds];
    const [alerts, findings] = await Promise.all([
      db.query.auditAlerts.findMany({
        where: and(
          inArray(schema.auditAlerts.id, ids),
          eq(schema.auditAlerts.orgId, orgId),
        ),
        columns: { id: true, status: true },
      }),
      db.query.analysisFindings.findMany({
        where: and(
          inArray(schema.analysisFindings.id, ids),
          eq(schema.analysisFindings.orgId, orgId),
        ),
        columns: { id: true, status: true },
      }),
    ]);
    for (const a of alerts) statusById.set(a.id, a.status);
    for (const f of findings) statusById.set(f.id, f.status);
  }

  const proposals = proposalRows.map((p) => {
    if (p.kind !== "alert_decision") return toProposalView(p);
    const live: NonNullable<AgentProposalView["liveStatuses"]> = {};
    for (const id of (p.payload as AlertDecisionPayload).unitIds) {
      const status = statusById.get(id);
      if (status) live[id] = status;
    }
    return toProposalView(p, live);
  });

  const toolResults = collectToolResults(messageRows);
  return {
    conversation,
    messages: messageRows
      .map((r) => toDisplayMessage(r, toolResults))
      .filter((m): m is DisplayMessage => m !== null),
    proposals,
    turnInFlight: !lockIsStale(conversation.turnStartedAt, new Date()),
  };
}
