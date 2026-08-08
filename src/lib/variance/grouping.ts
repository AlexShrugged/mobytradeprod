// Pure list math over the variance queue: impact double-count dedupe, the
// canonical within-line ordering, line-item grouping for the consolidated
// queue, and the Accept/Dismiss auto-advance cursor. No IO.

const SEVERITY_ORDER = { error: 0, warning: 1, info: 2 } as const;

const keySuffix = (alertKey: string) =>
  alertKey.slice(alertKey.indexOf(":") + 1);

export type ImpactCountRow = {
  entryId: string;
  alertKey: string;
  alertType: string;
  impactCents: number | null;
};

/** Recoverable/exposure sums in cents, counting each dollar once.
 *
 *  A rate mismatch and an amount mismatch on the same charge describe the
 *  same dollars, so the rate row yields to the amount row; CI per-SKU value
 *  rows slice up dollars their entry's invoice_total row already claims.
 *  Suppressors come from `context` — pass the full queue when summing a
 *  subset, because a group's invoice_total suppressor is entry-scoped and
 *  lives outside the group. Charge matching is scoped by entryId so entry
 *  A's amount row can't swallow entry B's rate row on a same-named charge. */
export function dedupedImpactSums(
  rows: ImpactCountRow[],
  context: ImpactCountRow[] = rows,
): { recoverable: number; exposure: number } {
  const amountCharges = new Set(
    context
      .filter((r) => r.alertType === "amount_mismatch")
      .map((r) => `${r.entryId}:${keySuffix(r.alertKey)}`),
  );
  const invoiceTotalEntries = new Set(
    context
      .filter(
        (r) =>
          r.alertKey === "value_mismatch:invoice_total" &&
          r.impactCents !== null,
      )
      .map((r) => r.entryId),
  );
  let recoverable = 0;
  let exposure = 0;
  for (const r of rows) {
    if (r.impactCents === null) continue;
    if (
      r.alertType === "rate_mismatch" &&
      amountCharges.has(`${r.entryId}:${keySuffix(r.alertKey)}`)
    ) {
      continue;
    }
    if (
      r.alertKey.startsWith("value_mismatch:invoice_sku:") &&
      invoiceTotalEntries.has(r.entryId)
    ) {
      continue;
    }
    if (r.impactCents > 0) recoverable += r.impactCents;
    else exposure += -r.impactCents;
  }
  return { recoverable, exposure };
}

export type SiblingLike = { id: string; alertKey: string; alertType: string };

export type SiblingUnit<S extends SiblingLike> = {
  primary: S;
  /** The amount_mismatch twin riding along — same charge, same dollars.
   *  Never separately decidable; it follows the primary's decision. */
  consequence: S | null;
};

/** Fold a sibling list into decidable units. A rate_mismatch and its
 *  amount_mismatch twin (same charge suffix) form ONE unit — the wrong rate
 *  is the cause, the duty dollars its consequence — everything else is a
 *  singleton. The rate is always the unit's primary, but a unit takes the
 *  list position of whichever member appears first, so the fold preserves
 *  the caller's ordering. Callers pass siblings from ONE line, so entry
 *  scoping is implicit. */
export function pairSiblingAlerts<S extends SiblingLike>(
  siblings: S[],
): SiblingUnit<S>[] {
  const consumed = new Set<string>();
  const twinOf = (s: S, type: string) =>
    siblings.find(
      (t) =>
        !consumed.has(t.id) &&
        t.id !== s.id &&
        t.alertType === type &&
        keySuffix(t.alertKey) === keySuffix(s.alertKey),
    );
  const units: SiblingUnit<S>[] = [];
  for (const s of siblings) {
    if (consumed.has(s.id)) continue;
    consumed.add(s.id);
    if (s.alertType === "rate_mismatch") {
      const twin = twinOf(s, "amount_mismatch");
      if (twin) {
        consumed.add(twin.id);
        units.push({ primary: s, consequence: twin });
        continue;
      }
    }
    if (s.alertType === "amount_mismatch") {
      const twin = twinOf(s, "rate_mismatch");
      if (twin) {
        consumed.add(twin.id);
        units.push({ primary: twin, consequence: s });
        continue;
      }
    }
    units.push({ primary: s, consequence: null });
  }
  return units;
}

/** Every alert id the unit decides as one. */
export function unitIds<S extends SiblingLike>(unit: SiblingUnit<S>): string[] {
  return unit.consequence
    ? [unit.primary.id, unit.consequence.id]
    : [unit.primary.id];
}

/** A unit is open while ANY member is open; otherwise the primary's call
 *  (a legacy divergent pair reads as the primary's decision, and deciding
 *  it again re-aligns both rows). */
export function unitStatus<S extends SiblingLike & { status: AlertStatus }>(
  unit: SiblingUnit<S>,
): AlertStatus {
  if (unit.primary.status === "open") return "open";
  if (unit.consequence && unit.consequence.status === "open") return "open";
  return unit.primary.status;
}

export type VarianceMemberOrd = {
  impactCents: number | null;
  severity: "error" | "warning" | "info";
  alertKey: string;
};

/** Canonical within-line order: |impact| desc (nulls last), then severity,
 *  then alertKey. Status-independent, so a card item keeps its slot when
 *  accepted or dismissed while working a line top-down. The queue's grouped
 *  rows (open members only) use this directly; the navigator card applies it
 *  within each band of compareSiblingAlerts, so the card's open tail always
 *  mirrors the queue stack and "next down" names the same issue in both. */
export function compareVarianceMembers(
  a: VarianceMemberOrd,
  b: VarianceMemberOrd,
): number {
  const ai = a.impactCents === null ? -1 : Math.abs(a.impactCents);
  const bi = b.impactCents === null ? -1 : Math.abs(b.impactCents);
  if (ai !== bi) return bi - ai;
  const s = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
  if (s !== 0) return s;
  return a.alertKey.localeCompare(b.alertKey);
}

export type AlertStatus = "open" | "resolved" | "dismissed";

/** Navigator-card order: decided issues first, open issues last — a new
 *  issue arriving on an already-worked line lands at the bottom, below its
 *  accepted/dismissed history ("3 of 3"). Canonical order within each band,
 *  so a fresh all-open line reads exactly like the queue's grouped row, and
 *  deciding issues top-down never reshuffles the card. */
export function compareSiblingAlerts(
  a: VarianceMemberOrd & { status: AlertStatus },
  b: VarianceMemberOrd & { status: AlertStatus },
): number {
  const band = (s: AlertStatus) => (s === "open" ? 1 : 0);
  const d = band(a.status) - band(b.status);
  if (d !== 0) return d;
  return compareVarianceMembers(a, b);
}

export type GroupableRow = VarianceMemberOrd & {
  alertId: string;
  alertType: string;
  entryId: string;
  entryNumber: string;
  lineItemId: string | null;
  lineNumber: number | null;
  href: string;
};

export type VarianceGroup<R extends GroupableRow> = {
  /** lineItemId for line groups; alertId for entry-scoped singletons. */
  id: string;
  /** compareVarianceMembers order — members[0] is the worst issue and
   *  supplies the row's line/entry/window cells and click target. */
  members: R[];
  recoverableCents: number;
  exposureCents: number;
  href: string;
};

/** One row per line item. Alerts without a lineItemId (entry-scoped, or
 *  orphaned by re-ingestion) stay singletons keyed by alertId and keep
 *  their entry-page href. SKU-scoped invoice alerts anchor lineItemId to
 *  the SKU's first entry line, so a SKU spanning several lines groups
 *  under its anchor line only — the message names the SKU, and the invoice
 *  evidence card shows every line.
 *
 *  Groups sort by total dollars in play desc (zero-impact last), then the
 *  worst member's severity, then entry/line for stability.
 *
 *  `context` feeds the impact-dedupe suppressor sets — pass a wider row set
 *  when `rows` is a slice of the queue (see partitionVarianceRows). */
export function groupVarianceRows<R extends GroupableRow>(
  rows: R[],
  context: ImpactCountRow[] = rows,
): VarianceGroup<R>[] {
  const byKey = new Map<string, R[]>();
  for (const r of rows) {
    const key = r.lineItemId ?? r.alertId;
    const bucket = byKey.get(key);
    if (bucket) bucket.push(r);
    else byKey.set(key, [r]);
  }
  const groups = [...byKey.entries()].map(([id, members]) => {
    members.sort(compareVarianceMembers);
    const { recoverable, exposure } = dedupedImpactSums(members, context);
    return {
      id,
      members,
      recoverableCents: recoverable,
      exposureCents: exposure,
      href: members[0].href,
    };
  });
  groups.sort((x, y) => {
    const xt = x.recoverableCents + x.exposureCents;
    const yt = y.recoverableCents + y.exposureCents;
    if (xt !== yt) return yt - xt;
    const s =
      SEVERITY_ORDER[x.members[0].severity] -
      SEVERITY_ORDER[y.members[0].severity];
    if (s !== 0) return s;
    const xe = x.members[0].entryNumber;
    const ye = y.members[0].entryNumber;
    if (xe !== ye) return xe < ye ? -1 : 1;
    return (x.members[0].lineNumber ?? 0) - (y.members[0].lineNumber ?? 0);
  });
  return groups;
}

/** Split the full queue (any status) into the ACTIVE set — lines with at
 *  least one open issue, open members only, so the table reads exactly as
 *  it would without history (a line's decided issues live on the detail
 *  page's navigator card) — and the ARCHIVED set: lines and entry-scoped
 *  singletons where every issue has been decided. A new issue on an
 *  archived line puts the line back in the active set by definition.
 *
 *  Active impact sums keep open-rows-only context (a decided suppressor no
 *  longer claims the dollars of an open row); archived sums see the full
 *  queue so a decided pair still dedupes. */
export function partitionVarianceRows<
  R extends GroupableRow & { status: AlertStatus },
>(rows: R[]): { active: VarianceGroup<R>[]; archived: VarianceGroup<R>[] } {
  const open = rows.filter((r) => r.status === "open");
  const activeKeys = new Set(open.map((r) => r.lineItemId ?? r.alertId));
  const archivedRows = rows.filter(
    (r) => r.status !== "open" && !activeKeys.has(r.lineItemId ?? r.alertId),
  );
  return {
    active: groupVarianceRows(open),
    archived: groupVarianceRows(archivedRows, rows),
  };
}

/** Auto-advance target after Accept/Dismiss: the first open sibling below
 *  the current one, wrapping to the ones above — literal "down only" would
 *  strand the user after deciding the bottom item while open work remains
 *  higher up. Null when nothing else is open. */
export function nextOpenSiblingId(
  siblings: { id: string; status: "open" | "resolved" | "dismissed" }[],
  currentId: string,
): string | null {
  const i = siblings.findIndex((s) => s.id === currentId);
  const rotated =
    i === -1 ? siblings : [...siblings.slice(i + 1), ...siblings.slice(0, i)];
  return rotated.find((s) => s.status === "open")?.id ?? null;
}
