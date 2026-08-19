"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Anchor } from "lucide-react";
import { cn } from "@/lib/utils";
import { ThemeToggle } from "@/components/theme-toggle";

const workspaceLinks = [
  { href: "/variance", label: "Variance" },
  { href: "/entries", label: "Entries" },
  { href: "/parts", label: "Parts" },
  { href: "/events", label: "Events" },
  { href: "/assistant", label: "Assistant" },
];

const adminLinks = [
  { href: "/data", label: "Data" },
  { href: "/settings", label: "Settings" },
];

function NavLink({ href, label }: { href: string; label: string }) {
  const pathname = usePathname();
  const active = pathname.startsWith(href);
  return (
    <Link
      href={href}
      className={cn(
        "rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
        active
          ? "bg-accent text-foreground"
          : "text-muted-foreground hover:text-foreground",
      )}
    >
      {label}
    </Link>
  );
}

// The auth surface stands alone — no app chrome behind the Clerk cards.
const NAVLESS_ROUTES = ["/sign-in", "/sign-up", "/org-selection"];

// authSlot carries the Clerk widgets (org switcher + user button) as
// serialized JSX from the server layout — no Clerk imports here, so the
// auth-disabled dev mode never touches Clerk on the client.
export function TopNav({ authSlot }: { authSlot?: React.ReactNode }) {
  const pathname = usePathname();
  if (NAVLESS_ROUTES.some((route) => pathname.startsWith(route))) return null;
  return (
    <header className="sticky top-0 z-40 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80">
      <div className="mx-auto flex h-14 w-full max-w-[1400px] items-center gap-6 px-4 sm:px-6">
        <Link href="/variance" className="flex items-center gap-2">
          <Anchor className="size-5" />
          <span className="text-sm font-semibold tracking-tight">MobyTrade</span>
        </Link>
        <nav className="flex items-center gap-1">
          {workspaceLinks.map((l) => (
            <NavLink key={l.href} {...l} />
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-1">
          {adminLinks.map((l) => (
            <NavLink key={l.href} {...l} />
          ))}
          <div className="ml-2 flex items-center gap-2">
            <ThemeToggle />
            {authSlot}
          </div>
        </div>
      </div>
    </header>
  );
}
