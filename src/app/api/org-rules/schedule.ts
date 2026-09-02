import { after } from "next/server";

import {
  AFTER_RESPONSE_DRAIN,
  processPendingAnalyses,
  queueReanalysesForOrgRule,
} from "@/lib/analysis/service";
import type { RuleChange } from "@/lib/analysis/rule-scope";
import { db } from "@/lib/db";

// Shared by the org-rule routes: decide the change's reach, queue the
// re-analyses, and drain — all AFTER the response. The reach includes a
// Claude scoping call (rule-scope.ts) that can take a minute or more, and a
// Settings save must not wait on it; the response reports the queue as
// pending (analysesQueued: null) rather than a count. The scoper's own
// budget (one attempt, RULE_SCOPE_DEADLINE_MS) plus the drain (three claims
// in 60s, 600s analyst deadline) stays inside the routes' maxDuration 800.
export function scheduleRuleReanalysis(orgId: string, change: RuleChange): void {
  after(async () => {
    try {
      const queued = await queueReanalysesForOrgRule(db, orgId, change);
      if (queued > 0) await processPendingAnalyses(db, AFTER_RESPONSE_DRAIN);
    } catch (err) {
      console.error("re-analysis after org rule change failed:", err);
    }
  });
}
