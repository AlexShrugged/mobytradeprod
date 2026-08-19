// Assistant selection, mirroring analysis/index.ts: the real model when
// ANTHROPIC_API_KEY is set, the deterministic stub otherwise - and the
// stub REFUSED on Vercel (an echo bot presenting as an assistant in a paid
// product is worse than an explicit configuration failure). The message
// route turns AgentNotConfiguredError into a 503.

import { isProdRuntime } from "../env";

import { ClaudeAgent } from "./claude";
import { StubAgent } from "./stub";
import type { AgentRunner } from "./types";

export class AgentNotConfiguredError extends Error {}

/** Whether /assistant can run a turn here - drives the page banner. */
export function isAgentConfigured(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY) || !isProdRuntime();
}

export function getAgent(): AgentRunner {
  if (process.env.ANTHROPIC_API_KEY) return new ClaudeAgent();
  if (isProdRuntime()) {
    throw new AgentNotConfiguredError(
      "ANTHROPIC_API_KEY is required on Vercel - refusing the stub assistant.",
    );
  }
  return new StubAgent();
}
