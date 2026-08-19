// Pure conversation helpers - split from service.ts (server-only) so
// vitest can pin them.

export const DEADLINE_MS = Number(process.env.AGENT_DEADLINE_MS) || 300_000;
/** Slack past the deadline before a crashed turn's lock is reclaimable. */
export const LOCK_GRACE_MS = 60_000;

/** First user message -> conversation title: 60 chars, word boundary. */
export function deriveTitle(text: string): string {
  const clean = text.trim().replace(/\s+/g, " ");
  if (clean.length === 0) return "New conversation";
  if (clean.length <= 60) return clean;
  const cut = clean.slice(0, 60);
  const space = cut.lastIndexOf(" ");
  return (space > 20 ? cut.slice(0, space) : cut).trimEnd();
}

/** Model-generated title -> stored title: strip wrapping quotes and a
 *  trailing period, collapse whitespace, cap at the deriveTitle boundary.
 *  Null when nothing usable remains (caller keeps the derived fallback). */
export function sanitizeTitle(raw: string): string | null {
  const clean = raw
    .trim()
    .replace(/\s+/g, " ")
    .replace(/^["'`«“‘]+/, "")
    .replace(/["'`»”’]+$/, "")
    .replace(/\.+$/, "")
    .trim();
  if (clean.length === 0) return null;
  return deriveTitle(clean);
}

/** Stale-lock predicate: no lock, or a lock older than deadline + grace. */
export function lockIsStale(
  turnStartedAt: Date | null,
  now: Date,
  deadlineMs = DEADLINE_MS,
): boolean {
  if (turnStartedAt === null) return true;
  return now.getTime() - turnStartedAt.getTime() > deadlineMs + LOCK_GRACE_MS;
}
