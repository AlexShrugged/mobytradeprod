// Pure view-shaping for the Parts page vendor panel: one part's sources and
// quote lines partitioned into vendors with real import activity (POs,
// invoices, entries) and an archive of offer-only vendors. The archive only
// exists relative to activity: when NO vendor has any, everyone shows in the
// main list — hiding a part's only vendors behind "quote archive" reads as
// having none. Quotes are offers FROM vendors, so every quote attaches to
// its vendor's group; a sheet that named no supplier lands in a single
// trailing "unattributed" group.
//
// Structural generics on purpose — the query layer's row types flow through
// untouched and this module stays importable from client components and
// tests without the server-only query module.

export type VendorUsageCounts = {
  poCount: number;
  invoiceCount: number;
  entryCount: number;
};

export type GroupableSource = {
  vendorId: string;
  vendorName: string;
  usage: VendorUsageCounts;
};

export type GroupableQuote = {
  vendorId: string | null;
  supplierName: string | null;
};

export type PartVendorGroup<S, Q> = {
  /** Stable render key: the vendor id, or "unattributed". */
  key: string;
  vendorId: string | null;
  /** Source vendor name, else the declared supplier text off the quotes. */
  vendorName: string | null;
  /** The (part, vendor) sourcing row — null for quote-only vendors. */
  source: S | null;
  /** This vendor's quote lines, in the caller's (newest-first) order. */
  quotes: Q[];
};

export type PartVendorGroups<S, Q> = {
  /**
   * Vendors with actual activity behind them, most active first — or, when
   * no vendor has any, every vendor (nothing hides in the archive then).
   */
  used: PartVendorGroup<S, Q>[];
  /** Offer-only and idle vendors, freshest offer first; unattributed last. */
  archive: PartVendorGroup<S, Q>[];
};

const hasUsage = (u: VendorUsageCounts): boolean =>
  u.poCount > 0 || u.invoiceCount > 0 || u.entryCount > 0;

export function groupPartVendors<
  S extends GroupableSource,
  Q extends GroupableQuote,
>(sources: S[], quotes: Q[]): PartVendorGroups<S, Q> {
  const quotesByVendor = new Map<string, Q[]>();
  const firstQuoteIndex = new Map<string, number>();
  const unattributed: Q[] = [];
  quotes.forEach((q, index) => {
    if (q.vendorId === null) {
      unattributed.push(q);
      return;
    }
    const list = quotesByVendor.get(q.vendorId) ?? [];
    list.push(q);
    quotesByVendor.set(q.vendorId, list);
    if (!firstQuoteIndex.has(q.vendorId)) {
      firstQuoteIndex.set(q.vendorId, index);
    }
  });

  const sourceVendorIds = new Set(sources.map((s) => s.vendorId));
  const groups: PartVendorGroup<S, Q>[] = sources.map((s) => ({
    key: s.vendorId,
    vendorId: s.vendorId,
    vendorName: s.vendorName,
    source: s,
    quotes: quotesByVendor.get(s.vendorId) ?? [],
  }));
  for (const [vendorId, vendorQuotes] of quotesByVendor) {
    if (sourceVendorIds.has(vendorId)) continue;
    groups.push({
      key: vendorId,
      vendorId,
      vendorName:
        vendorQuotes.find((q) => q.supplierName !== null)?.supplierName ?? null,
      source: null,
      quotes: vendorQuotes,
    });
  }

  const used = groups
    .filter((g) => g.source !== null && hasUsage(g.source.usage))
    .sort((a, b) => {
      const ua = (a.source as S).usage;
      const ub = (b.source as S).usage;
      if (ua.entryCount !== ub.entryCount) return ub.entryCount - ua.entryCount;
      if (ua.poCount !== ub.poCount) return ub.poCount - ua.poCount;
      if (ua.invoiceCount !== ub.invoiceCount) {
        return ub.invoiceCount - ua.invoiceCount;
      }
      return (a.vendorName ?? "").localeCompare(b.vendorName ?? "");
    });

  const archive = groups
    .filter((g) => g.source === null || !hasUsage(g.source.usage))
    .sort((a, b) => {
      const ia = firstQuoteIndex.get(a.vendorId as string) ?? Infinity;
      const ib = firstQuoteIndex.get(b.vendorId as string) ?? Infinity;
      if (ia !== ib) return ia - ib;
      return (a.vendorName ?? "").localeCompare(b.vendorName ?? "");
    });
  if (unattributed.length > 0) {
    archive.push({
      key: "unattributed",
      vendorId: null,
      vendorName: null,
      source: null,
      quotes: unattributed,
    });
  }

  if (used.length === 0) return { used: archive, archive: [] };
  return { used, archive };
}
