// Pure access-policy half of the super-admin seam — no request machinery,
// so it tests as plain lib logic (access.test.ts). The request-facing half
// (cookies) lives in ./index.ts.

import { createHash, timingSafeEqual } from "node:crypto";

/** Timing-safe secret comparison. Hashing both sides first makes the
 *  comparison length-independent (timingSafeEqual requires equal lengths). */
export function secretMatches(
  provided: string | undefined | null,
  expected: string,
): boolean {
  if (!provided) return false;
  const a = createHash("sha256").update(provided).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

/** The whole admission policy in one testable place.
 *  - No SUPER_ADMIN_SECRET configured → open. Deliberate: every mutation
 *    route in the app is unauthenticated until real auth lands (the
 *    CRON_SECRET check in /api/tariff-sync GET has the same unset-skips
 *    posture), and a closed-by-default gate would brick local dev, which
 *    has no login UI to recover through.
 *  - Configured → the admin cookie must carry the exact secret. */
export function resolveAdminAccess(
  envSecret: string | undefined,
  cookieValue: string | undefined,
): boolean {
  if (!envSecret) return true;
  return secretMatches(cookieValue, envSecret);
}
