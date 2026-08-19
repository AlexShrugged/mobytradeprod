// Rebuild the Anthropic wire transcript from persisted agent_messages rows.
// Three jobs, all deterministic and pure:
//   1. normalize content (string -> one text block) and preserve seq order;
//   2. repair dangling tool_use blocks an aborted turn left behind (every
//      tool_use must be answered by a tool_result in the NEXT user message,
//      or the API rejects the transcript) by synthesizing is_error results;
//   3. elide the oldest tool_result bodies once the transcript exceeds the
//      character budget, so long conversations keep fitting. Elision
//      rewrites early bytes and busts the prompt-cache prefix — acceptable,
//      it only kicks in past the budget.

export type StoredMessage = { role: string; content: unknown };

export type WireBlock = Record<string, unknown> & { type: string };
export type WireMessage = { role: "user" | "assistant"; content: WireBlock[] };

export const DEFAULT_BUDGET_CHARS = 150_000;
export const ELIDED_MARKER = "[elided older tool output]";
const INTERRUPTED_RESULT = "[interrupted - no result recorded]";
/** The tail of the transcript elision never touches. */
const PROTECTED_TAIL = 4;

export function normalizeContentBlocks(content: unknown): WireBlock[] {
  if (typeof content === "string") {
    return [{ type: "text", text: content }];
  }
  if (Array.isArray(content)) {
    return content.filter(
      (b): b is WireBlock =>
        Boolean(b) && typeof b === "object" && typeof (b as WireBlock).type === "string",
    );
  }
  return [];
}

const toolUseIds = (m: WireMessage): string[] =>
  m.content
    .filter((b) => b.type === "tool_use" && typeof b.id === "string")
    .map((b) => b.id as string);

const toolResultIds = (m: WireMessage): Set<string> =>
  new Set(
    m.content
      .filter(
        (b) => b.type === "tool_result" && typeof b.tool_use_id === "string",
      )
      .map((b) => b.tool_use_id as string),
  );

function syntheticResult(toolUseId: string): WireBlock {
  return {
    type: "tool_result",
    tool_use_id: toolUseId,
    content: INTERRUPTED_RESULT,
    is_error: true,
  };
}

/** Rows (seq order) -> repaired wire messages. */
export function rebuildMessages(
  rows: StoredMessage[],
  opts: { budgetChars?: number } = {},
): WireMessage[] {
  const messages: WireMessage[] = rows
    .filter((r) => r.role === "user" || r.role === "assistant")
    .map((r) => ({
      role: r.role as "user" | "assistant",
      content: normalizeContentBlocks(r.content),
    }))
    .filter((m) => m.content.length > 0);

  // Repair: every assistant tool_use needs a matching tool_result in the
  // next user message. Extend that message, or insert one, as needed.
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role !== "assistant") continue;
    const uses = toolUseIds(m);
    if (uses.length === 0) continue;
    const next = messages[i + 1];
    if (next && next.role === "user") {
      const answered = toolResultIds(next);
      const missing = uses.filter((id) => !answered.has(id));
      if (missing.length > 0) {
        // tool_result blocks must lead the message.
        next.content = [...missing.map(syntheticResult), ...next.content];
      }
    } else {
      messages.splice(i + 1, 0, {
        role: "user",
        content: uses.map(syntheticResult),
      });
    }
  }

  elideToBudget(messages, opts.budgetChars ?? DEFAULT_BUDGET_CHARS);
  return messages;
}

/** Append this turn's user text, merging into a trailing user message (a
 *  repaired abort can leave one) so roles keep alternating. */
export function appendUserMessage(
  messages: WireMessage[],
  text: string,
): WireMessage[] {
  const block: WireBlock = { type: "text", text };
  const last = messages[messages.length - 1];
  if (last && last.role === "user") {
    last.content = [...last.content, block];
    return messages;
  }
  messages.push({ role: "user", content: [block] });
  return messages;
}

const sizeOf = (messages: WireMessage[]): number =>
  JSON.stringify(messages).length;

function elideToBudget(messages: WireMessage[], budgetChars: number): void {
  if (sizeOf(messages) <= budgetChars) return;
  const cutoff = Math.max(0, messages.length - PROTECTED_TAIL);
  for (let i = 0; i < cutoff; i++) {
    const m = messages[i];
    if (m.role !== "user") continue;
    let changed = false;
    m.content = m.content.map((b) => {
      if (b.type !== "tool_result") return b;
      if (b.content === ELIDED_MARKER) return b;
      changed = true;
      return { ...b, content: ELIDED_MARKER };
    });
    if (changed && sizeOf(messages) <= budgetChars) return;
  }
}
