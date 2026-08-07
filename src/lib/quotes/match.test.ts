import { describe, expect, it } from "vitest";

import {
  diffQuoteAgainstSource,
  pickWinningQuote,
  poLineMatchesQuote,
  selectSupersededLineIds,
  type PoLineMatchInput,
  type QuoteLineMatchInput,
  type SourceSnapshot,
} from "./match";

function po(over: Partial<PoLineMatchInput> = {}): PoLineMatchInput {
  return {
    partId: "part-1",
    unitPrice: 100,
    orderDate: "2026-06-15",
    currency: "USD",
    vendorId: "vendor-shenzhen",
    ...over,
  };
}

function quote(over: Partial<QuoteLineMatchInput> = {}): QuoteLineMatchInput {
  return {
    partId: "part-1",
    unitCost: 100,
    currency: "USD",
    quoteDate: "2026-06-01",
    vendorId: "vendor-shenzhen",
    ...over,
  };
}

describe("poLineMatchesQuote", () => {
  it("matches when part, date, price, currency, and vendor all agree", () => {
    expect(poLineMatchesQuote(po(), quote())).toBe(true);
  });

  it("requires the same part; a partless PO line never matches", () => {
    expect(poLineMatchesQuote(po({ partId: "part-2" }), quote())).toBe(false);
    expect(poLineMatchesQuote(po({ partId: null }), quote())).toBe(false);
  });

  it("PO ordered on the quote date matches; a day earlier does not", () => {
    expect(
      poLineMatchesQuote(po({ orderDate: "2026-06-01" }), quote()),
    ).toBe(true);
    expect(
      poLineMatchesQuote(po({ orderDate: "2026-05-31" }), quote()),
    ).toBe(false);
  });

  it("unknown dates never block: null quoteDate or null orderDate match", () => {
    expect(
      poLineMatchesQuote(
        po({ orderDate: "2020-01-01" }),
        quote({ quoteDate: null }),
      ),
    ).toBe(true);
    expect(poLineMatchesQuote(po({ orderDate: null }), quote())).toBe(true);
  });

  it("price agreement holds at exactly 0.5% and fails just past it", () => {
    // quote $100 → tolerance max($0.01, $0.50) = $0.50
    expect(poLineMatchesQuote(po({ unitPrice: 100.5 }), quote())).toBe(true);
    expect(poLineMatchesQuote(po({ unitPrice: 99.5 }), quote())).toBe(true);
    expect(poLineMatchesQuote(po({ unitPrice: 100.51 }), quote())).toBe(false);
    expect(poLineMatchesQuote(po({ unitPrice: 99.49 }), quote())).toBe(false);
  });

  it("the $0.01 floor governs when 0.5% is smaller", () => {
    // quote $1 → 0.5% = $0.005, floor lifts tolerance to $0.01
    const cheap = quote({ unitCost: 1 });
    expect(poLineMatchesQuote(po({ unitPrice: 1.01 }), cheap)).toBe(true);
    expect(poLineMatchesQuote(po({ unitPrice: 0.99 }), cheap)).toBe(true);
    expect(poLineMatchesQuote(po({ unitPrice: 1.02 }), cheap)).toBe(false);
  });

  it("a PO line without a unit price never matches", () => {
    expect(poLineMatchesQuote(po({ unitPrice: null }), quote())).toBe(false);
  });

  it("currency must agree (case-insensitively); a mismatch blocks even at equal price", () => {
    expect(
      poLineMatchesQuote(po({ currency: "EUR" }), quote()),
    ).toBe(false);
    expect(poLineMatchesQuote(po({ currency: "usd" }), quote())).toBe(true);
  });

  it("vendors gate only when both sides resolved one", () => {
    // Both present, different → block.
    expect(
      poLineMatchesQuote(po({ vendorId: "vendor-other" }), quote()),
    ).toBe(false);
    // Missing PO vendor does not block.
    expect(poLineMatchesQuote(po({ vendorId: null }), quote())).toBe(true);
    // Missing sheet vendor does not block either.
    expect(poLineMatchesQuote(po(), quote({ vendorId: null }))).toBe(true);
    expect(
      poLineMatchesQuote(po({ vendorId: null }), quote({ vendorId: null })),
    ).toBe(true);
  });
});

describe("pickWinningQuote", () => {
  const line = (
    id: string,
    quoteDate: string | null,
    createdAt = "2026-06-01T00:00:00Z",
  ) => ({ id, quoteDate, createdAt });

  it("returns null on no candidates", () => {
    expect(pickWinningQuote([])).toBeNull();
  });

  it("newest sheet quote date wins", () => {
    const winner = pickWinningQuote([
      line("a", "2026-05-01"),
      line("b", "2026-06-01"),
      line("c", "2026-04-01"),
    ]);
    expect(winner?.id).toBe("b");
  });

  it("an undated sheet loses to any dated one", () => {
    const winner = pickWinningQuote([
      line("a", null, "2026-07-01T00:00:00Z"),
      line("b", "2026-01-01", "2026-01-01T00:00:00Z"),
    ]);
    expect(winner?.id).toBe("b");
  });

  it("ties on quote date break by newest createdAt, then by id", () => {
    const byCreated = pickWinningQuote([
      line("a", "2026-06-01", "2026-06-01T08:00:00Z"),
      line("b", "2026-06-01", "2026-06-02T08:00:00Z"),
    ]);
    expect(byCreated?.id).toBe("b");

    const byId = pickWinningQuote([
      line("a", "2026-06-01"),
      line("b", "2026-06-01"),
    ]);
    expect(byId?.id).toBe("b");
  });

  it("does not mutate the input array", () => {
    const input = [line("b", "2026-06-01"), line("a", "2026-05-01")];
    pickWinningQuote(input);
    expect(input.map((l) => l.id)).toEqual(["b", "a"]);
  });
});

describe("selectSupersededLineIds", () => {
  const incoming = {
    id: "new",
    partId: "part-1",
    vendorId: "vendor-acme",
  };

  it("supersedes received lines for the same part and vendor only", () => {
    const ids = selectSupersededLineIds(incoming, [
      { id: "old-1", partId: "part-1", status: "received", vendorId: "vendor-acme" },
      { id: "other-part", partId: "part-2", status: "received", vendorId: "vendor-acme" },
      { id: "other-vendor", partId: "part-1", status: "received", vendorId: "vendor-bolt" },
    ]);
    expect(ids).toEqual(["old-1"]);
  });

  it("never supersedes decided lines — approved/applied/rejected survive re-ingestion", () => {
    const ids = selectSupersededLineIds(incoming, [
      { id: "approved", partId: "part-1", status: "approved", vendorId: "vendor-acme" },
      { id: "applied", partId: "part-1", status: "applied", vendorId: "vendor-acme" },
      { id: "rejected", partId: "part-1", status: "rejected", vendorId: "vendor-acme" },
      { id: "superseded", partId: "part-1", status: "superseded", vendorId: "vendor-acme" },
    ]);
    expect(ids).toEqual([]);
  });

  it("excludes the incoming line itself", () => {
    const ids = selectSupersededLineIds(incoming, [
      { id: "new", partId: "part-1", status: "received", vendorId: "vendor-acme" },
    ]);
    expect(ids).toEqual([]);
  });

  it("an unnamed sheet (null vendor) supersedes only other unnamed sheets", () => {
    const unnamed = { id: "new", partId: "part-1", vendorId: null };
    const ids = selectSupersededLineIds(unnamed, [
      { id: "named", partId: "part-1", status: "received", vendorId: "vendor-acme" },
      { id: "nullish", partId: "part-1", status: "received", vendorId: null },
    ]);
    expect(ids).toEqual(["nullish"]);
  });
});

describe("diffQuoteAgainstSource", () => {
  const source = (over: Partial<NonNullable<SourceSnapshot>> = {}) => ({
    unitCost: "100.0000",
    countryOfOrigin: "CN",
    ...over,
  });

  it("no diffs when the quote repeats the source's values", () => {
    expect(
      diffQuoteAgainstSource(
        { unitCost: 100, countryOfOrigin: "CN" },
        source(),
      ),
    ).toEqual([]);
  });

  it("cost compares at 4-decimal precision, tolerating numeric round-trips", () => {
    expect(
      diffQuoteAgainstSource(
        { unitCost: 100, countryOfOrigin: null },
        source({ unitCost: "100.00" }),
      ),
    ).toEqual([]);

    const diffs = diffQuoteAgainstSource(
      { unitCost: 97.5, countryOfOrigin: null },
      source(),
    );
    expect(diffs).toEqual([
      {
        field: "unit_cost",
        column: "unitCost",
        oldValue: "100.0000",
        newValue: "97.5000",
      },
    ]);
  });

  it("a null source (vendor new for this part) seeds the full row", () => {
    const diffs = diffQuoteAgainstSource(
      { unitCost: 12.3456, countryOfOrigin: "vn" },
      null,
    );
    expect(diffs).toEqual([
      {
        field: "unit_cost",
        column: "unitCost",
        oldValue: null,
        newValue: "12.3456",
      },
      {
        field: "country_of_origin",
        column: "countryOfOrigin",
        oldValue: null,
        newValue: "VN",
      },
    ]);
  });

  it("COO changes only when the quote carries one — never nulled out", () => {
    // Quote silent on COO → the source's value stands.
    expect(
      diffQuoteAgainstSource({ unitCost: 100, countryOfOrigin: null }, source()),
    ).toEqual([]);

    const diffs = diffQuoteAgainstSource(
      { unitCost: 100, countryOfOrigin: "vn" },
      source(),
    );
    expect(diffs).toEqual([
      {
        field: "country_of_origin",
        column: "countryOfOrigin",
        oldValue: "CN",
        newValue: "VN",
      },
    ]);
  });

  it("never emits an HTS field — quotes cannot write classification", () => {
    const diffs = diffQuoteAgainstSource(
      { unitCost: 1, countryOfOrigin: "VN" },
      null,
    );
    for (const d of diffs) {
      expect(["unit_cost", "country_of_origin"]).toContain(d.field);
    }
  });
});
