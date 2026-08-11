// Pure access-policy half of the super-admin seam — no request machinery,
// so it tests as plain lib logic (access.test.ts). The request-facing half
// (Clerk session) lives in ./index.ts.

/** SUPER_ADMIN_USER_IDS is a comma-separated list of Clerk user ids. */
export function parseAllowlist(raw: string | undefined): string[] {
  return (
    raw
      ?.split(",")
      .map((s) => s.trim())
      .filter(Boolean) ?? []
  );
}

/** The whole admission policy in one testable place.
 *  - Clerk disabled → open. Deliberate: only reachable in local dev —
 *    auth/config.ts refuses to boot on Vercel without Clerk keys, so a
 *    closed-by-default gate would only brick local dev, which has no login
 *    UI to recover through.
 *  - Clerk enabled → the signed-in user must be allowlisted. An empty
 *    allowlist admits nobody. */
export function resolveAdminAccess(
  allowlist: string[],
  userId: string | null,
  clerkEnabled: boolean,
): boolean {
  if (!clerkEnabled) return true;
  return userId !== null && allowlist.includes(userId);
}
