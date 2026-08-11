import { notFound } from "next/navigation";
import { SignUp } from "@clerk/nextjs";

import { clerkEnabled } from "@/lib/auth/config";

// Force-dynamic (repo convention) — also keeps the build from prerendering
// Clerk widgets outside a ClerkProvider when keys are absent.
export const dynamic = "force-dynamic";

// Self-serve signup is disabled in the Clerk dashboard, but this page is
// still needed for organization-invitation acceptance flows.
export default function SignUpPage() {
  if (!clerkEnabled) notFound();
  return (
    <div className="flex min-h-[70vh] items-center justify-center">
      <SignUp />
    </div>
  );
}
