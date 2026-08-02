"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Anchor } from "lucide-react";
import { cn } from "@/lib/utils";
import { ThemeToggle } from "@/components/theme-toggle";

const workspaceLinks = [
  { href: "/entries", label: "Entries" },
  { href: "/parts", label: "Parts" },
  { href: "/events", label: "Events" },
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

export function TopNav() {
  return (
    <header className="sticky top-0 z-40 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80">
      <div className="mx-auto flex h-14 w-full max-w-[1400px] items-center gap-6 px-4 sm:px-6">
        <Link href="/entries" className="flex items-center gap-2">
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
          <div className="ml-2">
            <ThemeToggle />
          </div>
        </div>
      </div>
    </header>
  );
}
