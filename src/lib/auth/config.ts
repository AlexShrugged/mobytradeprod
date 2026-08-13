import { isProdRuntime } from "@/lib/env";

// The single source of truth for "is Clerk on" — read by the proxy, the
// root layout, org.ts, and the admin gate, which must all branch on the
// identical value. Deliberately db-free: the proxy bundles this file and
// must never touch PGlite.
export const clerkEnabled: boolean = Boolean(
  process.env.CLERK_SECRET_KEY &&
    process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY,
);

// Fail closed on Vercel: a deploy (preview or production) without Clerk
// keys must not come up auth-open. Module scope → build and boot both fail
// fast.
if (!clerkEnabled && isProdRuntime()) {
  throw new Error(
    "Clerk keys are required on Vercel. Set NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY and CLERK_SECRET_KEY.",
  );
}
