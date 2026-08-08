import { describe, expect, it } from "vitest";

import { groupKeyFor, groupMapKey, partitionRevisions } from "./grouping";
import type { ProposedRevision } from "./types";

const revision = (
  ch99Code: string,
  changeType: ProposedRevision["changeType"] = "create_measure",
  authority: ProposedRevision["authority"] = "section_301",
): ProposedRevision => ({
  changeType,
  ch99Code,
  authority,
  targetMeasureId: null,
  proposed: {
    name: `Measure ${ch99Code}`,
    authority,
    scope: "all_products",
    countries: null,
    effectiveDate: null,
    endDate: null,
    sailedOnOrAfter: null,
    sailedOnOrBefore: null,
    rate: 0.25,
    exemption: false,
    inLieuOfBaseDuty: false,
    prefixes: [],
    notes: null,
  },
  evidence: {
    description: "",
    general: "",
    special: "",
    additionalDuties: "",
    footnotes: "",
    highlights: [],
  },
  liveSnapshot: null,
  contentHash: `hash-${ch99Code}`,
});

describe("groupKeyFor", () => {
  it("keys by authority and 6-digit prefix with a readable title", () => {
    expect(groupKeyFor(revision("9903.88.15"))).toEqual({
      authority: "section_301",
      ch99Prefix: "990388",
      title: "Adopt 9903.88.xx — Section 301",
    });
  });
});

describe("partitionRevisions", () => {
  it("groups create_measure by family and leaves tracked changes individual", () => {
    const { grouped, individual } = partitionRevisions([
      revision("9903.88.01"),
      revision("9903.88.02"),
      revision("9903.88.15"),
      revision("9903.01.20", "create_measure", "ieepa"),
      revision("9903.85.02", "rate_change", "section_232_aluminum"),
      revision("9903.88.03", "note_change"),
    ]);

    expect(individual.map((r) => r.ch99Code)).toEqual([
      "9903.85.02",
      "9903.88.03",
    ]);
    expect([...grouped.keys()].sort()).toEqual([
      "ieepa:990301",
      "section_301:990388",
    ]);
    expect(
      grouped.get("section_301:990388")!.revisions.map((r) => r.ch99Code),
    ).toEqual(["9903.88.01", "9903.88.02", "9903.88.15"]);
  });

  it("splits one prefix across authorities into separate groups", () => {
    // Chapters get re-purposed — authority is part of the key on purpose.
    const { grouped } = partitionRevisions([
      revision("9903.94.01", "create_measure", "section_232_steel"),
      revision("9903.94.05", "create_measure", "other"),
    ]);
    expect(grouped.size).toBe(2);
    expect(
      groupMapKey({ authority: "section_232_steel", ch99Prefix: "990394" }),
    ).toBe("section_232_steel:990394");
  });
});
