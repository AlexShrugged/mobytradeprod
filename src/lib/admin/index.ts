// Platform-operator (super-admin) seam. Guards the GLOBAL reference
// mutations (tariff sync, revision / group / base-release approval) that
// take effect for every org — a different axis from org.ts, which answers
// "which tenant is this request for". Admission = the signed-in Clerk user
// appears in the SUPER_ADMIN_USER_IDS allowlist OR belongs to the
// SUPER_ADMIN_ORG_ID Clerk organization (dev-open when Clerk is disabled,
// which auth/config.ts restricts to local dev).
//
// App-layer only: never import from tsx scripts, and call outside
// db.transaction — same posture as getCurrentActorName.

import { cache } from "react";
import { NextResponse } from "next/server";
import { auth, clerkClient, currentUser } from "@clerk/nextjs/server";

import { clerkEnabled } from "@/lib/auth/config";

import { parseAllowlist, resolveAdminAccess } from "./access";

/** True when the signed-in user belongs to the SUPER_ADMIN_ORG_ID Clerk
 *  organization. Keyed on the org ID, never the slug — members can rename
 *  slugs, ids are unforgeable. The session's active org answers without a
 *  network call; only an admin browsing from inside a tenant org falls
 *  through to the membership API. */
async function memberOfAdminOrg(
  userId: string | null,
  activeOrgId: string | null | undefined,
): Promise<boolean> {
  const adminOrg = process.env.SUPER_ADMIN_ORG_ID?.trim();
  if (!adminOrg || !userId) return false;
  if (activeOrgId === adminOrg) return true;
  const clerk = await clerkClient();
  const { data } = await clerk.users.getOrganizationMembershipList({
    userId,
    limit: 100,
  });
  return data.some((m) => m.organization.id === adminOrg);
}

/** True when the caller is a platform operator. See resolveAdminAccess for
 *  the policy. React cache(): pages ask more than once per render and the
 *  answer may cost a Clerk API call. */
export const isSuperAdmin = cache(async (): Promise<boolean> => {
  if (!clerkEnabled) return resolveAdminAccess([], null, false);
  const { userId, orgId } = await auth();
  const allowlist = parseAllowlist(process.env.SUPER_ADMIN_USER_IDS);
  // Allowlist first — it never needs the network.
  if (resolveAdminAccess(allowlist, userId, true)) return true;
  return resolveAdminAccess(
    allowlist,
    userId,
    true,
    await memberOfAdminOrg(userId, orgId),
  );
});

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
