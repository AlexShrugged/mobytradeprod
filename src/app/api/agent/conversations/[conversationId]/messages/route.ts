import { NextResponse, after } from "next/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { AgentNotConfiguredError, getAgent } from "@/lib/agent";
import { encodeEvent } from "@/lib/agent/protocol";
import {
  claimTurn,
  runTurn,
  TurnInFlightError,
} from "@/lib/agent/service";
import type { AgentEvent } from "@/lib/agent/types";
import { db, schema } from "@/lib/db";
import { getCurrentOrgId } from "@/lib/org";

// One assistant turn: NDJSON protocol events streamed over a POST
// response. The turn is server-authoritative - a client Stop or dropped
// connection only stops the rendering (enqueue failures are swallowed and
// the work promise is registered with after()), while every completed
// message persists as the turn progresses; the client recovers state with
// router.refresh(). One turn per conversation at a time (409).
export const maxDuration = 800;

const HEARTBEAT_MS = 15_000;

const postBody = z.object({
  content: z.string().trim().min(1).max(8_000),
});

export async function POST(
  request: Request,
  { params }: { params: Promise<{ conversationId: string }> },
) {
  const { conversationId } = await params;
  const orgId = await getCurrentOrgId();

  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const parsed = postBody.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid body." },
      { status: 400 },
    );
  }

  const conversation = await db.query.agentConversations.findFirst({
    where: and(
      eq(schema.agentConversations.id, conversationId),
      eq(schema.agentConversations.orgId, orgId),
    ),
  });
  if (!conversation) {
    return NextResponse.json(
      { error: "Conversation not found." },
      { status: 404 },
    );
  }

  let agent;
  try {
    agent = getAgent();
  } catch (err) {
    if (err instanceof AgentNotConfiguredError) {
      return NextResponse.json({ error: err.message }, { status: 503 });
    }
    throw err;
  }

  try {
    await claimTurn(conversationId);
  } catch (err) {
    if (err instanceof TurnInFlightError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    throw err;
  }

  const encoder = new TextEncoder();
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  let closed = false;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
    cancel() {
      closed = true;
    },
  });
  const send = (event: AgentEvent) => {
    if (closed || !controller) return;
    try {
      controller.enqueue(encoder.encode(encodeEvent(event)));
    } catch {
      closed = true;
    }
  };

  const heartbeat = setInterval(() => send({ type: "heartbeat" }), HEARTBEAT_MS);
  const work = (async () => {
    try {
      await runTurn({
        conversation,
        userText: parsed.data.content,
        sink: { emit: send },
        // Deliberately NOT request.signal: a client Stop must not abort
        // the turn (persist-regardless). The runner's own deadline is the
        // only abort.
        signal: new AbortController().signal,
        agent,
      });
    } finally {
      clearInterval(heartbeat);
      // controller is assigned in start() before any of this runs; TS can't
      // see through the closure, hence the local.
      const c = controller as ReadableStreamDefaultController<Uint8Array> | null;
      if (!closed && c) {
        try {
          c.close();
        } catch {
          // already closed by cancel
        }
      }
    }
  })();
  // Keep the invocation alive past a client disconnect - the turn finishes
  // and persists either way.
  after(() => work);

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
