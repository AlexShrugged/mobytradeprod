import { describe, expect, it } from "vitest";

import { groupPartVendors, type VendorUsageCounts } from "./part-vendor-groups";

const usage = (
  poCount = 0,
  invoiceCount = 0,
  entryCount = 0,
): VendorUsageCounts => ({ poCount, invoiceCount, entryCount });

const source = (vendorId: string, vendorName: string, u = usage()) => ({
  vendorId,
  vendorName,
  usage: u,
});

const quote = (vendorId: string | null, supplierName: string | null = null) => ({
  vendorId,
  supplierName,
});

describe("groupPartVendors", () => {
  it("splits sources into used (any activity) and archive (none)", () => {
    const { used, archive } = groupPartVendors(
      [
        source("v1", "Hangzhou", usage(2, 1, 3)),
        source("v2", "Ningbo"),
        source("v3", "Taichung", usage(0, 0, 1)),
      ],
      [],
    );
    expect(used.map((g) => g.key)).toEqual(["v1", "v3"]);
    expect(archive.map((g) => g.key)).toEqual(["v2"]);
  });

  it("orders used vendors by entries, then POs, then invoices, then name", () => {
    const { used } = groupPartVendors(
      [
        source("b", "Beta", usage(1, 0, 2)),
        source("a", "Alpha", usage(3, 0, 2)),
        source("c", "Gamma", usage(0, 5, 3)),
        source("d", "Delta", usage(1, 1, 2)),
        source("e", "Aardvark", usage(1, 1, 2)),
      ],
      [],
    );
    // c leads on entries; among the entryCount=2 tier, a leads on POs and
    // the (1,1,2) tie breaks alphabetically.
    expect(used.map((g) => g.vendorName)).toEqual([
      "Gamma",
      "Alpha",
      "Aardvark",
      "Delta",
      "Beta",
    ]);
  });

  it("attaches quotes to their vendor's group in input order", () => {
    const q1 = quote("v1", "Hangzhou");
    const q2 = quote("v2", "Ningbo");
    const q3 = quote("v1", "Hangzhou");
    const { used, archive } = groupPartVendors(
      [source("v1", "Hangzhou", usage(1))],
      [q1, q2, q3],
    );
    expect(used).toHaveLength(1);
    expect(used[0].quotes).toEqual([q1, q3]);
    expect(archive).toHaveLength(1);
    expect(archive[0].source).toBeNull();
    expect(archive[0].vendorName).toBe("Ningbo");
    expect(archive[0].quotes).toEqual([q2]);
  });

  it("orders the archive by freshest quote first, quoteless sources after", () => {
    // The quotes array arrives newest-first; v3's offer is fresher than v2's.
    const { archive } = groupPartVendors(
      [source("v2", "Ningbo"), source("v4", "Idle Co")],
      [quote("v3", "Shenzhen"), quote("v2", "Ningbo")],
    );
    expect(archive.map((g) => g.vendorName)).toEqual([
      "Shenzhen",
      "Ningbo",
      "Idle Co",
    ]);
  });

  it("collects vendor-less quotes into a trailing unattributed group", () => {
    const anon = quote(null);
    const { archive } = groupPartVendors(
      [],
      [anon, quote("v1", "Hangzhou")],
    );
    expect(archive.map((g) => g.key)).toEqual(["v1", "unattributed"]);
    expect(archive[1].vendorId).toBeNull();
    expect(archive[1].quotes).toEqual([anon]);
  });

  it("returns empty groups for a part with no sources or quotes", () => {
    expect(groupPartVendors([], [])).toEqual({ used: [], archive: [] });
  });
});
