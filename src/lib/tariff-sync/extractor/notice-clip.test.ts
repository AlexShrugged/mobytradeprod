import { describe, expect, it } from "vitest";

import { clipNoticeForCodes } from "./notice-clip";

const pad = (n: number) => "x".repeat(n);

describe("clipNoticeForCodes", () => {
  it("returns a window around an exact code mention", () => {
    const text = `${pad(3000)} subheading 9903.01.20 shall apply to goods entered for consumption on or after February 4, 2025 ${pad(3000)}`;
    const clip = clipNoticeForCodes(text, ["9903.01.20"]);
    expect(clip).toContain("9903.01.20");
    expect(clip).toContain("February 4, 2025");
    expect(clip!.length).toBeLessThan(text.length);
  });

  it("merges overlapping windows for nearby codes", () => {
    const text = `${pad(2000)} 9903.01.20 and 9903.01.21 apply ${pad(2000)}`;
    const clip = clipNoticeForCodes(text, ["9903.01.20", "9903.01.21"]);
    expect(clip).not.toContain(" … ");
    expect(clip).toContain("9903.01.20 and 9903.01.21");
  });

  it("joins distant windows with an ellipsis", () => {
    const text = `A 9903.01.20 here ${pad(6000)} and 9903.88.15 there`;
    const clip = clipNoticeForCodes(text, ["9903.01.20", "9903.88.15"]);
    expect(clip).toContain(" … ");
    expect(clip).toContain("9903.88.15");
  });

  it("falls back to the dotted prefix for range-staged codes", () => {
    const text = `${pad(2000)} subheadings 9903.01.01 through 9903.01.15 are effective March 4, 2025 ${pad(2000)}`;
    const clip = clipNoticeForCodes(text, ["9903.01.05"]);
    expect(clip).toContain("effective March 4, 2025");
  });

  it("returns null when neither codes nor prefixes appear", () => {
    expect(clipNoticeForCodes("nothing relevant here", ["9903.01.20"])).toBeNull();
  });

  it("exactOnly suppresses the prefix fallback", () => {
    const text = `${pad(100)} subheadings 9903.01.01 through 9903.01.15 apply ${pad(100)}`;
    expect(
      clipNoticeForCodes(text, ["9903.01.05"], { exactOnly: true }),
    ).toBeNull();
    expect(clipNoticeForCodes(text, ["9903.01.05"])).toContain("through");
  });

  it("caps total excerpt length", () => {
    const mention = " 9903.01.20 ";
    const text = Array.from({ length: 30 }, () => pad(4000) + mention).join("");
    const clip = clipNoticeForCodes(text, ["9903.01.20"]);
    expect(clip!.length).toBeLessThanOrEqual(8000);
  });
});
