import { notFound } from "next/navigation";
import { OrganizationList } from "@clerk/nextjs";

import { clerkEnabled } from "@/lib/auth/config";

// Force-dynamic (repo convention) — also keeps the build from prerendering
// Clerk widgets outside a ClerkProvider when keys are absent.
export const dynamic = "force-dynamic";

// Where the proxy sends signed-in sessions that have no active
// organization. Org creation is operator-driven (self-serve creation is
// disabled in the Clerk dashboard), so an empty list means "not invited
// yet".
export default function OrgSelectionPage() {
  if (!clerkEnabled) notFound();
  return (
    <div className="flex min-h-[70vh] flex-col items-center justify-center gap-4">
      <OrganizationList
        hidePersonal
        afterSelectOrganizationUrl="/variance"
        afterCreateOrganizationUrl="/variance"
      />
      <p className="max-w-sm text-center text-sm text-muted-foreground">
        Select an organization to continue. If none is listed, ask your
        MobyTrade contact for an invitation.
      </p>
    </div>
  );
}
