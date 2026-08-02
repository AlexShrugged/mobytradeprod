import { describe, expect, it } from "vitest";

import {
  diffQuoteAgainstPart,
  pickWinningQuote,
  poLineMatchesQuote,
  selectSupersededLineIds,
  type PartSnapshot,
  type PoLineMatchInput,
  type QuoteLineMatchInput,
} from "./match";

function po(over: Partial<PoLineMatchInput> = {}): PoLineMatchInput {
  return {
    partId: "part-1",
    unitPrice: 100,
    orderDate: "2026-06-15",
    currency: "USD",
    supplierName: "Shenzhen E-Mobility Co.",
    ...over,
  };
}

function quote(over: Partial<QuoteLineMatchInput> = {}): QuoteLineMatchInput {
  return {
    partId: "part-1",
    unitCost: 100,
    currency: "USD",
    quoteDate: "2026-06-01",
    supplierName: "Shenzhen E-Mobility Co.",
    ...over,
  };
}

describe("poLineMatchesQuote", () => {
  it("matches when part, date, price, currency, and supplier all agree", () => {
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

  it("supplier names gate only when both sides carry one", () => {
    // Both present, different → block.
    expect(
      poLineMatchesQuote(po({ supplierName: "Other Supplier Ltd." }), quote()),
    ).toBe(false);
    // Trim/casefold variants are the same supplier.
    expect(
      poLineMatchesQuote(
        po({ supplierName: "  SHENZHEN e-mobility co. " }),
        quote(),
      ),
    ).toBe(true);
    // Missing PO supplier does not block.
    expect(poLineMatchesQuote(po({ supplierName: null }), quote())).toBe(true);
    // Missing sheet supplier does not block either.
    expect(
      poLineMatchesQuote(po(), quote({ supplierName: null })),
    ).toBe(true);
    expect(
      poLineMatchesQuote(
        po({ supplierName: null }),
        quote({ supplierName: null }),
      ),
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
    supplierName: "Acme Trading",
  };

  it("supersedes received lines for the same part and supplier only", () => {
    const ids = selectSupersededLineIds(incoming, [
      { id: "old-1", partId: "part-1", status: "received", supplierName: " acme TRADING " },
      { id: "other-part", partId: "part-2", status: "received", supplierName: "Acme Trading" },
      { id: "other-supplier", partId: "part-1", status: "received", supplierName: "Bolt Works" },
    ]);
    expect(ids).toEqual(["old-1"]);
  });

  it("never supersedes decided lines — approved/applied/rejected survive re-ingestion", () => {
    const ids = selectSupersededLineIds(incoming, [
      { id: "approved", partId: "part-1", status: "approved", supplierName: "Acme Trading" },
      { id: "applied", partId: "part-1", status: "applied", supplierName: "Acme Trading" },
      { id: "rejected", partId: "part-1", status: "rejected", supplierName: "Acme Trading" },
      { id: "superseded", partId: "part-1", status: "superseded", supplierName: "Acme Trading" },
    ]);
    expect(ids).toEqual([]);
  });

  it("excludes the incoming line itself", () => {
    const ids = selectSupersededLineIds(incoming, [
      { id: "new", partId: "part-1", status: "received", supplierName: "Acme Trading" },
    ]);
    expect(ids).toEqual([]);
  });

  it("an unnamed sheet supersedes only other unnamed sheets", () => {
    const unnamed = { id: "new", partId: "part-1", supplierName: null };
    const ids = selectSupersededLineIds(unnamed, [
      { id: "named", partId: "part-1", status: "received", supplierName: "Acme Trading" },
      { id: "blank", partId: "part-1", status: "received", supplierName: "  " },
      { id: "nullish", partId: "part-1", status: "received", supplierName: null },
    ]);
    expect(ids).toEqual(["blank", "nullish"]);
  });
});

describe("diffQuoteAgainstPart", () => {
  const part = (over: Partial<PartSnapshot> = {}): PartSnapshot => ({
    unitCost: "100.0000",
    countryOfOrigin: "CN",
    manufacturer: "Shenzhen E-Mobility Co.",
    ...over,
  });

  it("no diffs when the quote repeats the part's values", () => {
    expect(
      diffQuoteAgainstPart(
        {
          unitCost: 100,
          countryOfOrigin: "CN",
          supplierName: "Shenzhen E-Mobility Co.",
        },
        part(),
      ),
    ).toEqual([]);
  });

  it("cost compares at 4-decimal precision, tolerating numeric round-trips", () => {
    expect(
      diffQuoteAgainstPart(
        { unitCost: 100, countryOfOrigin: null, supplierName: null },
        part({ unitCost: "100.00" }),
      ),
    ).toEqual([]);

    const diffs = diffQuoteAgainstPart(
      { unitCost: 97.5, countryOfOrigin: null, supplierName: null },
      part(),
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

  it("a null part cost records the seed write", () => {
    const diffs = diffQuoteAgainstPart(
      { unitCost: 12.3456, countryOfOrigin: null, supplierName: null },
      part({ unitCost: null }),
    );
    expect(diffs[0]).toMatchObject({
      field: "unit_cost",
      oldValue: null,
      newValue: "12.3456",
    });
  });

  it("COO and manufacturer change only when the quote carries them", () => {
    // Quote silent on COO/supplier → the part's values stand.
    expect(
      diffQuoteAgainstPart(
        { unitCost: 100, countryOfOrigin: null, supplierName: null },
        part(),
      ),
    ).toEqual([]);

    const diffs = diffQuoteAgainstPart(
      { unitCost: 100, countryOfOrigin: "vn", supplierName: "Bolt Works" },
      part(),
    );
    expect(diffs).toEqual([
      {
        field: "country_of_origin",
        column: "countryOfOrigin",
        oldValue: "CN",
        newValue: "VN",
      },
      {
        field: "manufacturer",
        column: "manufacturer",
        oldValue: "Shenzhen E-Mobility Co.",
        newValue: "Bolt Works",
      },
    ]);
  });

  it("never emits an HTS field — quotes cannot write classification", () => {
    const diffs = diffQuoteAgainstPart(
      { unitCost: 1, countryOfOrigin: "VN", supplierName: "Bolt Works" },
      part({ unitCost: null, countryOfOrigin: null, manufacturer: null }),
    );
    for (const d of diffs) {
      expect(["unit_cost", "country_of_origin", "manufacturer"]).toContain(
        d.field,
      );
    }
  });
});
