// The per-request organization pin. Clerk keeps ONE session cookie per
// browser and lets whichever tab was focused last write its own active
// organization into it, so a request from a tab that rendered tenant A can
// arrive at the server carrying tenant B's claim (a teammate onboarding a
// tenant filed 22 of 71 entry summaries into another customer's org this
// way, 2026-09-23). Every browser call therefore names the org the page
// was rendered under, and the proxy refuses a mismatch instead of trusting
// the cookie alone. Pure and dependency-free: the proxy bundles this file.

/** Request header carrying the Clerk org id the page rendered under. */
export const ORG_PIN_HEADER = "x-moby-org";

/** `<body data-moby-org>` attribute the root layout renders the pin into. */
export const ORG_PIN_ATTRIBUTE = "data-moby-org";

export const ORG_PIN_MISMATCH_CODE = "org_mismatch";
export const ORG_PIN_MISSING_CODE = "org_pin_missing";

export const ORG_PIN_MISMATCH_MESSAGE =
  "Organization changed in another tab. Reload the page.";
export const ORG_PIN_MISSING_MESSAGE = `Missing ${ORG_PIN_HEADER} header.`;

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export function isMutatingMethod(method: string): boolean {
  return MUTATING_METHODS.has(method.toUpperCase());
}

export type OrgPinVerdict = "ok" | "missing" | "mismatch";

/**
 * Decide whether a request's pin agrees with the session's active org.
 * A present pin must match on every method (a read from a stale tab is
 * refused too, so the page reloads instead of silently showing another
 * tenant). An absent pin is refused on mutations — only browser code sends
 * it, and browser code always does — and tolerated on reads, which
 * navigations and prefetches make without one.
 */
export function orgPinVerdict(args: {
  method: string;
  sessionOrgId: string | null | undefined;
  pinnedOrgId: string | null | undefined;
}): OrgPinVerdict {
  const pinned = args.pinnedOrgId?.trim() || null;
  if (pinned === null) {
    return isMutatingMethod(args.method) ? "missing" : "ok";
  }
  return pinned === (args.sessionOrgId ?? null) ? "ok" : "mismatch";
}
