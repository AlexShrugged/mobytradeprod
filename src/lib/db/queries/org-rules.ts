import "server-only";

import { db } from "@/lib/db";
import type { OrgRule } from "@/lib/db/schema";
import { getCurrentOrgId } from "@/lib/org";
import { loadOrgRules } from "@/lib/org-rules";

// Data page list, creation order. All rules (enabled and disabled) — the UI
// shows the toggle state. Never call inside db.transaction (PGlite
// single-session rule).
export async function getOrgRules(): Promise<OrgRule[]> {
  const orgId = await getCurrentOrgId();
  return loadOrgRules(db, orgId);
}
