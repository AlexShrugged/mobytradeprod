"use client";

import { useRouter } from "next/navigation";

import { TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";

// A diff-table row that navigates to the variance that put it in question —
// the whole row is the click target, so tapping a flagged field lands on
// that issue with the sidebar selection following. Inner links (source
// citations) keep their own destinations. No hover prefetch needed: the
// nav card already full-prefetches every sibling page.
export function LinkedTableRow({
  href,
  className,
  children,
}: {
  href?: string;
  className?: string;
  children: React.ReactNode;
}) {
  const router = useRouter();
  if (!href) return <TableRow className={className}>{children}</TableRow>;
  return (
    <TableRow
      className={cn("cursor-pointer", className)}
      onClick={(e) => {
        if ((e.target as HTMLElement).closest("a")) return;
        router.push(href);
      }}
    >
      {children}
    </TableRow>
  );
}
