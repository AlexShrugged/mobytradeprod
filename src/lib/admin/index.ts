// Platform-operator (super-admin) seam. The app has no auth yet; this
// guards the GLOBAL reference mutations (tariff sync, revision / group /
// base-release approval) that take effect for every org — a different axis
// from org.ts, which answers "which tenant is this request for". When auth
// (Clerk) lands, isSuperAdmin becomes a role check on the session and
// callers never change.
//
// App-layer only (imports next/headers): never import from tsx scripts, and
// call outside db.transaction — same posture as getCurrentActorName.

import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import { resolveAdminAccess } from "./access";

export const ADMIN_COOKIE = "mt_admin";

/** True when the caller is the platform operator. See resolveAdminAccess
 *  for the policy (env unset → dev-open). */
export async function isSuperAdmin(): Promise<boolean> {
  const jar = await cookies();
  return resolveAdminAccess(
    process.env.SUPER_ADMIN_SECRET,
    jar.get(ADMIN_COOKIE)?.value,
  );
}

/** Route-handler guard: null when allowed, a 403 response to return when
 *  not. Usage: `const denied = await requireSuperAdmin(); if (denied) return denied;` */
export async function requireSuperAdmin(): Promise<NextResponse | null> {
  if (await isSuperAdmin()) return null;
  return NextResponse.json(
    { error: "Super-admin access required." },
    { status: 403 },
  );
}

/** decidedBy for global approvals — free text until auth lands, same as
 *  review_items.decided_by everywhere else. */
export function getSuperAdminActorName(): string {
  return process.env.SUPER_ADMIN_NAME ?? "Platform admin";
}
