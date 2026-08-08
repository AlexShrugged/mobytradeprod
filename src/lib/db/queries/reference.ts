import "server-only";

import { cache } from "react";

import { db } from "@/lib/db";
import { loadReferenceDataForOrg } from "@/lib/duty/reference";
import type { ReferenceData } from "@/lib/duty/types";
import { getCurrentOrgId } from "@/lib/org";

// Per-request (React cache(): one RSC render / route invocation) org-scoped
// reference data. The full 30k-row base schedule is never loaded on a page
// path — only the org's digit universe (see loadOrgHtsDigits) plus the whole
// Chapter 99 / measure / stacking reference, which stays small.
//
// Call OUTSIDE db.transaction — same PGlite single-session rule as
// getCurrentActorName (org.ts): it queries the global db handle, and a
// transaction awaiting it would deadlock. Transactional callers (auditor
// sweeps, apply paths) use the explicit loaders with their own handle.
export const getReferenceDataForOrg = cache(
  async (): Promise<ReferenceData> => {
    const orgId = await getCurrentOrgId();
    return loadReferenceDataForOrg(db, orgId);
  },
);
