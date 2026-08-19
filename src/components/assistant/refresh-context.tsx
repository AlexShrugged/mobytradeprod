"use client";

import * as React from "react";
import { useRouter } from "next/navigation";

// Refresh indirection for the assistant surfaces. On /assistant (no
// provider) this is exactly router.refresh() — the RSC pages re-read the
// thread. The embedded widget provides an override that refetches its
// thread via the GET route AND router.refresh()es the page behind the
// panel, so proposal confirms reconcile both.
const RefreshContext = React.createContext<(() => void) | null>(null);

export const AssistantRefreshProvider = RefreshContext.Provider;

export function useAssistantRefresh(): () => void {
  const router = useRouter();
  const override = React.useContext(RefreshContext);
  // Memoized: callers put this in dependency arrays.
  return React.useMemo(
    () => override ?? (() => router.refresh()),
    [override, router],
  );
}
