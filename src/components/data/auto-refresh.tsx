"use client";

import * as React from "react";
import { useRouter } from "next/navigation";

// Server-driven status transitions (pending → processing → processed) have
// no push channel: the table is an RSC render and extraction runs minutes
// inside the process call. While any document is non-terminal the page
// re-fetches itself on a short interval; the refresh that shows the last
// terminal state also unmounts the poll (active flips false).
export function AutoRefresh({ active }: { active: boolean }) {
  const router = useRouter();
  React.useEffect(() => {
    if (!active) return;
    const id = setInterval(() => router.refresh(), 4000);
    return () => clearInterval(id);
  }, [active, router]);
  return null;
}
