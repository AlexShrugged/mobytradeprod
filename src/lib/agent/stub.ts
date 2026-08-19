// Deterministic local-dev assistant (no ANTHROPIC_API_KEY): echoes, and on
// a "propose"-shaped request runs the REAL variance-queue and
// propose_actions tools so the whole proposal-card flow is developable
// offline. Refused on Vercel (index.ts). Persists through the same seams
// as the Claude runner, so the transcript and thread render identically.

import { normalizeContentBlocks } from "./transcript";
import type {
  AgentRunner,
  AgentTurnInput,
  AgentTurnResult,
  AgentUsage,
} from "./types";

const ZERO_USAGE: AgentUsage = {
  iterations: 1,
  inputTokens: 0,
  cacheReadInputTokens: 0,
  cacheCreationInputTokens: 0,
  outputTokens: 0,
};

type RunnableLike = { name: string; run: (input: never) => unknown };

function lastUserText(messages: unknown[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as { role?: string; content?: unknown };
    if (m?.role !== "user") continue;
    const texts = normalizeContentBlocks(m.content)
      .filter((b) => b.type === "text" && typeof b.text === "string")
      .map((b) => b.text as string);
    if (texts.length > 0) return texts.join("\n");
  }
  return "";
}

export class StubAgent implements AgentRunner {
  readonly model = "stub";

  /** No model, no title - the derived fallback stands. */
  async generateTitle(): Promise<string | null> {
    return null;
  }

  async runTurn(input: AgentTurnInput): Promise<AgentTurnResult> {
    const text = lastUserText(input.messages);
    let reply: string;

    if (/propose/i.test(text)) {
      reply = await this.propose(input);
    } else {
      reply = `Stub assistant (no ANTHROPIC_API_KEY set). You said: "${text.slice(0, 200)}". Say "propose" to exercise the proposal card flow against the seeded variance queue.`;
    }

    input.sink.emit({ type: "text_delta", delta: reply });
    const rows = await input.persistNewMessages([
      { role: "assistant", content: [{ type: "text", text: reply }] },
    ]);
    const row = rows[0];
    if (row) {
      input.sink.emit({
        type: "message_final",
        message: {
          id: row.id,
          role: "assistant",
          seq: row.seq,
          blocks: [{ type: "text", text: reply }],
          createdAt:
            typeof row.createdAt === "string"
              ? row.createdAt
              : row.createdAt.toISOString(),
        },
      });
      if (input.pendingProposalIds.length > 0) {
        await input.attachProposals(input.pendingProposalIds.splice(0), row.id);
      }
    }
    return { usage: ZERO_USAGE, error: null };
  }

  private async propose(input: AgentTurnInput): Promise<string> {
    const tool = (name: string) =>
      input.tools.find((t) => t.name === name) as RunnableLike | undefined;
    const queueTool = tool("get_variance_queue");
    const proposeTool = tool("propose_actions");
    if (!queueTool || !proposeTool) return "Stub: tools unavailable.";

    const raw = (await queueTool.run({
      status: "open",
      alertType: null,
      entryNumber: null,
      limit: 5,
    } as never)) as string;
    let first: { id: string; label: string; entryNumber: string } | null = null;
    try {
      const parsed = JSON.parse(raw) as {
        rows?: { id: string; label: string; entryNumber: string }[];
      };
      first = parsed.rows?.[0] ?? null;
    } catch {
      first = null;
    }
    if (!first) return "Stub: no open variances to propose against.";

    const result = (await proposeTool.run({
      actions: [
        {
          kind: "alert_decision",
          alertId: first.id,
          decision: "resolved",
          note: "Stub proposal for local development.",
          entryId: null,
          reason: null,
        },
      ],
    } as never)) as string;
    if (result.startsWith("ERROR:")) return `Stub: ${result}`;
    return `Proposed resolving [${first.label}](/variance/${first.id}) on entry ${first.entryNumber}. Confirm or decline the card below.`;
  }
}
