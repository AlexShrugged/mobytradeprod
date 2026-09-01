"use client";

// Cross-tree opener for the embedded MobyAI panel. The widget mounts once
// in the root layout while callers (e.g. the variance card's chat button)
// live in unrelated subtrees, so this is a window event rather than React
// context. `subtitle` replaces the composer's default prompt line for the
// opened session only.

export type AssistantOpenDetail = { subtitle?: string };

const OPEN_EVENT = "mobyai:open";

export function openAssistant(detail: AssistantOpenDetail = {}) {
  window.dispatchEvent(new CustomEvent<AssistantOpenDetail>(OPEN_EVENT, { detail }));
}

export function onAssistantOpen(
  handler: (detail: AssistantOpenDetail) => void,
): () => void {
  const listener = (e: Event) =>
    handler((e as CustomEvent<AssistantOpenDetail>).detail ?? {});
  window.addEventListener(OPEN_EVENT, listener);
  return () => window.removeEventListener(OPEN_EVENT, listener);
}
