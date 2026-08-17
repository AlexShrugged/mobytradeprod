import { afterEach, describe, expect, it, vi } from "vitest";

import {
  fetchRecentNotices,
  passesKeywordGuard,
  searchNoticesForCodes,
  shiftDays,
} from "./federal-register";

const doc = (n: number, overrides: Record<string, unknown> = {}) => ({
  document_number: `2026-${String(n).padStart(5, "0")}`,
  title: `Modifying the Harmonized Tariff Schedule (doc ${n})`,
  html_url: `https://www.federalregister.gov/d/2026-${n}`,
  publication_date: "2026-01-15",
  abstract: "Additional duties on certain articles.",
  agencies: [{ name: "USTR" }],
  ...overrides,
});

const page = (docs: unknown[], nextPageUrl: string | null) => ({
  ok: true,
  json: async () => ({ results: docs, next_page_url: nextPageUrl }),
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchRecentNotices", () => {
  it("follows next_page_url across pages and aggregates notices", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        page(
          Array.from({ length: 100 }, (_, i) => doc(i + 1)),
          "https://www.federalregister.gov/api/v1/documents.json?page=2",
        ),
      )
      .mockResolvedValueOnce(page([doc(101), doc(102)], null));
    vi.stubGlobal("fetch", fetchMock);

    const { notices, raw } = await fetchRecentNotices({
      daysBack: 730,
      today: "2026-08-17",
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(notices).toHaveLength(102);
    expect(raw).toHaveLength(2);

    const firstUrl = new URL(fetchMock.mock.calls[0][0] as string);
    expect(firstUrl.searchParams.get("conditions[publication_date][gte]")).toBe(
      "2024-08-17",
    );
    expect(firstUrl.searchParams.get("per_page")).toBe("100");
    expect(firstUrl.searchParams.get("page")).toBe("1");
    const secondUrl = new URL(fetchMock.mock.calls[1][0] as string);
    expect(secondUrl.searchParams.get("page")).toBe("2");
  });

  it("stops after one request when the page is not full", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(page([doc(1), doc(2)], "https://example.com?page=2"));
    vi.stubGlobal("fetch", fetchMock);

    const { notices } = await fetchRecentNotices({
      daysBack: 30,
      today: "2026-08-17",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(notices).toHaveLength(2);
  });

  it("drops documents that miss the keyword guard", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      page(
        [
          doc(1),
          doc(2, {
            title: "Sunshine Act Meetings",
            abstract: "Unrelated agency housekeeping.",
          }),
        ],
        null,
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { notices } = await fetchRecentNotices({
      daysBack: 30,
      today: "2026-08-17",
    });

    expect(notices).toHaveLength(1);
    expect(notices[0].documentNumber).toBe("2026-00001");
  });

  it("throws on a non-ok response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 503 }),
    );

    await expect(
      fetchRecentNotices({ daysBack: 30, today: "2026-08-17" }),
    ).rejects.toThrow("Federal Register 503");
  });
});

describe("searchNoticesForCodes", () => {
  it("queries per exact quoted code and dedupes documents across codes", async () => {
    const fetchMock = vi.fn().mockResolvedValue(page([doc(7)], null));
    vi.stubGlobal("fetch", fetchMock);

    const notices = await searchNoticesForCodes(
      ["9903.94.01", "9903.94.32", "9903.94.01"],
      { daysBack: 730, today: "2026-08-17" },
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const url = new URL(fetchMock.mock.calls[0][0] as string);
    expect(url.searchParams.get("conditions[term]")).toMatch(/^"9903\.94\./);
    expect(notices).toHaveLength(1);
  });

  it("tolerates a failed search for one code", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("network"))
      .mockResolvedValueOnce(page([doc(8)], null));
    vi.stubGlobal("fetch", fetchMock);

    const notices = await searchNoticesForCodes(["9903.01.01", "9903.02.01"], {
      daysBack: 730,
      today: "2026-08-17",
    });
    expect(notices).toHaveLength(1);
  });
});

describe("passesKeywordGuard", () => {
  it("accepts tariff-relevant text and rejects noise", () => {
    expect(
      passesKeywordGuard({ title: "Reciprocal tariff update", abstract: null }),
    ).toBe(true);
    expect(
      passesKeywordGuard({ title: "Sunshine Act Meetings", abstract: null }),
    ).toBe(false);
  });
});

describe("shiftDays", () => {
  it("shifts across month and year boundaries", () => {
    expect(shiftDays("2026-08-17", -30)).toBe("2026-07-18");
    expect(shiftDays("2026-08-17", -730)).toBe("2024-08-17");
  });
});
