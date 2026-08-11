import { notFound } from "next/navigation";
import { SignIn } from "@clerk/nextjs";

import { clerkEnabled } from "@/lib/auth/config";

// Force-dynamic (repo convention) — also keeps the build from prerendering
// Clerk widgets outside a ClerkProvider when keys are absent.
export const dynamic = "force-dynamic";

export default function SignInPage() {
  if (!clerkEnabled) notFound();
  return (
    <div className="flex min-h-[70vh] items-center justify-center">
      <SignIn />
    </div>
  );
}
