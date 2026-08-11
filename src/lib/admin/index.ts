// Platform-operator (super-admin) seam. Guards the GLOBAL reference
// mutations (tariff sync, revision / group / base-release approval) that
// take effect for every org — a different axis from org.ts, which answers
// "which tenant is this request for". Admission = the signed-in Clerk user
// appears in the SUPER_ADMIN_USER_IDS allowlist (dev-open when Clerk is
// disabled, which auth/config.ts restricts to local dev).
//
// App-layer only: never import from tsx scripts, and call outside
// db.transaction — same posture as getCurrentActorName.

import { NextResponse } from "next/server";
import { auth, currentUser } from "@clerk/nextjs/server";

import { clerkEnabled } from "@/lib/auth/config";

import { parseAllowlist, resolveAdminAccess } from "./access";

/** True when the caller is a platform operator. See resolveAdminAccess for
 *  the policy. */
export async function isSuperAdmin(): Promise<boolean> {
  const userId = clerkEnabled ? (await auth()).userId : null;
  return resolveAdminAccess(
    parseAllowlist(process.env.SUPER_ADMIN_USER_IDS),
    userId,
    clerkEnabled,
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

/** decidedBy for global approvals — the operator's Clerk display name, or
 *  the SUPER_ADMIN_NAME fallback in auth-disabled dev. */
export async function getSuperAdminActorName(): Promise<string> {
  if (!clerkEnabled) return process.env.SUPER_ADMIN_NAME ?? "Platform admin";
  const user = await currentUser();
  const name =
    user?.fullName ??
    [user?.firstName, user?.lastName].filter(Boolean).join(" ");
  return name || user?.primaryEmailAddress?.emailAddress || "Platform admin";
}
