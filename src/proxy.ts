import { NextResponse, type NextRequest } from "next/server";
import { clerkMiddleware } from "@clerk/nextjs/server";

import { clerkEnabled } from "@/lib/auth/config";

// Default-protect: every page and API route requires a Clerk session (and
// an active organization for tenant surfaces) unless listed here. Handlers
// keep their own org-scoped lookups (eq(orgId) + 404) as the second layer.
//
// Next 16: this file replaces middleware.ts, always runs on the Node
// runtime, and must not set `export const runtime` (it throws).

// The cron GETs authenticate with CRON_SECRET inside the handler — the
// Vercel cron caller has no session. Method-checked here because matchers
// can't match methods.
function isPublicRoute(req: NextRequest): boolean {
  const { pathname } = req.nextUrl;
  if (pathname.startsWith("/sign-in") || pathname.startsWith("/sign-up")) {
    return true;
  }
  return (
    req.method === "GET" &&
    (pathname === "/api/tariff-sync" ||
      pathname === "/api/documents/sweep" ||
      pathname === "/api/analysis/sweep")
  );
}

// Signed-in but org-less sessions may still reach these: the admin surface
// and tariff-sync mutations are platform-global (super admins may belong to
// no org), the sweep is cross-org, and /org-selection is where org-less
// users land.
function isOrgExempt(pathname: string): boolean {
  return (
    pathname.startsWith("/api/tariff-sync") ||
    pathname === "/api/documents/sweep" ||
    pathname === "/api/analysis/sweep" ||
    pathname.startsWith("/admin") ||
    pathname.startsWith("/org-selection")
  );
}

const handler = clerkMiddleware(async (auth, req) => {
  if (isPublicRoute(req)) return;
  const { userId, orgId, redirectToSignIn } = await auth();
  const isApi = req.nextUrl.pathname.startsWith("/api");
  if (!userId) {
    if (isApi) {
      return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    }
    return redirectToSignIn({ returnBackUrl: req.url });
  }
  if (!orgId && !isOrgExempt(req.nextUrl.pathname)) {
    if (isApi) {
      return NextResponse.json(
        { error: "No active organization." },
        { status: 403 },
      );
    }
    return NextResponse.redirect(new URL("/org-selection", req.url));
  }
});

// Keys absent (local dev only — auth/config.ts throws on Vercel): straight
// pass-through, preserving the zero-env dev experience.
export default clerkEnabled
  ? handler
  : function proxy() {
      return NextResponse.next();
    };

export const config = {
  matcher: [
    // Skip Next internals and static assets, unless found in search params.
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    // Always run for API routes.
    "/(api|trpc)(.*)",
    // Clerk v7 proxies its Frontend API through the app domain — removing
    // this breaks sign-in.
    "/__clerk/(.*)",
  ],
};
