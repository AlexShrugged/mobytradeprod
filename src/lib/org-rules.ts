// Org rules: standing instructions an importer records (see the org_rules
// schema comment). This module is the shared seam — the zod spec contract,
// the plain loader, and the derived-kind helpers — used by the auditor,
// the analyst bundle, the agent service, the routes, and tsx scripts.
//
// Relative imports and no "server-only" on purpose: the auditor calls the
// loader under tsx scripts and inside linker transactions. Request-path
// reads go through src/lib/db/queries/org-rules.ts instead.

import { asc, eq } from "drizzle-orm";
import { z } from "zod";

import type { DbClient } from "./db";
import * as schema from "./db/schema";
import { auditAlertType, type OrgRule } from "./db/schema";

/** Strip everything but digits — HTS prefixes compare in digit space. */
export const normalizeHtsPrefix = (s: string): string => s.replace(/\D/g, "");

// The structured half of a suppression rule. Scope fields AND together;
// null means unscoped on that axis. Stored verbatim in org_rules.suppression.
export const suppressionSpecSchema = z.object({
  alertTypes: z.array(z.enum(auditAlertType.enumValues)).min(1),
  /** Case/whitespace-insensitive match on the line's declared supplier. */
  supplierName: z.string().trim().min(1).nullable(),
  /** ISO-2 country of origin, uppercased on write. */
  countryOfOrigin: z
    .string()
    .trim()
    .length(2)
    .transform((v) => v.toUpperCase())
    .nullable(),
  /** Dotted or bare HTS prefix; normalized to digits on write. */
  htsPrefix: z
    .string()
    .trim()
    .transform(normalizeHtsPrefix)
    .refine((v) => v.length >= 2, { message: "HTS prefix needs at least 2 digits." })
    .nullable(),
});

export type SuppressionSpec = z.infer<typeof suppressionSpecSchema>;

/** Rule kind is derived, never stored: a spec makes it a suppression rule. */
export const ruleKindOf = (rule: { suppression: unknown }) =>
  rule.suppression ? ("suppression" as const) : ("guidance" as const);

export const enabledRules = (rules: OrgRule[]): OrgRule[] =>
  rules.filter((r) => r.enabled);

export const activeSuppressionRules = (rules: OrgRule[]) =>
  rules
    .filter((r) => r.enabled && r.suppression != null)
    .map((r) => ({
      id: r.id,
      text: r.text,
      suppression: r.suppression as SuppressionSpec,
    }));

/** Plain loader — usable from auditor sweeps, the analyst bundle, the agent
 *  service, and tsx scripts (the duty/reference.ts ↔ queries/reference.ts
 *  split). Loads all rules; callers narrow with enabledRules/
 *  activeSuppressionRules. */
export async function loadOrgRules(
  db: DbClient,
  orgId: string,
): Promise<OrgRule[]> {
  return db.query.orgRules.findMany({
    where: eq(schema.orgRules.orgId, orgId),
    orderBy: [asc(schema.orgRules.createdAt)],
  });
}

/** Key-order-insensitive stringify — same contract as the auditor's private
 *  stableStringify. */
function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  const record = v as Record<string, unknown>;
  const body = Object.keys(record)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(record[k])}`)
    .join(",");
  return `{${body}}`;
}

const suppressionSemantics = (rule: {
  enabled: boolean;
  suppression: unknown;
}): string | null =>
  rule.enabled && rule.suppression != null
    ? stableStringify(rule.suppression)
    : null;

/** True when a mutation left the rule's effect on the auditor unchanged —
 *  the routes skip the org re-sweep in that case (text edits, guidance
 *  toggles). */
export const sameSuppressionSemantics = (
  before: { enabled: boolean; suppression: unknown },
  after: { enabled: boolean; suppression: unknown },
): boolean => suppressionSemantics(before) === suppressionSemantics(after);
