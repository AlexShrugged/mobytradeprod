import { describe, expect, it } from "vitest";

import { assembleEvents, groupByDay } from "./assemble";
import type { BusinessEvent } from "./types";

function ev(partial: Partial<BusinessEvent> & { id: string }): BusinessEvent {
  return {
    type: "entry_filed",
    occurredOn: "2026-07-01",
    dateBasis: "exact",
    recordedAt: "2026-07-02T00:00:00.000Z",
    title: partial.id,
    entityRefs: [],
    provenance: { kind: "system" },
    ...partial,
  };
}

describe("assembleEvents", () => {
  it("sorts by occurrence date desc, recordedAt desc, id as total-order tie", () => {
    const out = assembleEvents([
      [ev({ id: "a", occurredOn: "2026-07-01" })],
      [
        ev({ id: "b", occurredOn: "2026-07-03" }),
        ev({
          id: "c",
          occurredOn: "2026-07-03",
          recordedAt: "2026-07-05T00:00:00.000Z",
        }),
      ],
    ]);
    expect(out.map((e) => e.id)).toEqual(["c", "b", "a"]);
  });

  it("orders by when it occurred, not when it was recorded", () => {
    // A late-uploaded document about an old shipment sorts by the sail date.
    const out = assembleEvents([
      [
        ev({
          id: "late-doc",
          occurredOn: "2026-06-01",
          recordedAt: "2026-07-30T00:00:00.000Z",
        }),
        ev({
          id: "recent",
          occurredOn: "2026-07-20",
          recordedAt: "2026-07-20T00:00:00.000Z",
        }),
      ],
    ]);
    expect(out.map((e) => e.id)).toEqual(["recent", "late-doc"]);
  });

  it("filters by type set and applies the limit after sorting", () => {
    const out = assembleEvents(
      [
        [
          ev({ id: "a", type: "po_placed", occurredOn: "2026-07-01" }),
          ev({ id: "b", type: "entry_filed", occurredOn: "2026-07-02" }),
          ev({ id: "c", type: "po_placed", occurredOn: "2026-07-03" }),
        ],
      ],
      { types: ["po_placed"], limit: 1 },
    );
    expect(out.map((e) => e.id)).toEqual(["c"]);
  });
});

describe("groupByDay", () => {
  it("groups consecutive same-day events preserving order", () => {
    const groups = groupByDay([
      ev({ id: "a", occurredOn: "2026-07-03" }),
      ev({ id: "b", occurredOn: "2026-07-03" }),
      ev({ id: "c", occurredOn: "2026-07-01" }),
    ]);
    expect(groups.map((g) => [g.day, g.events.length])).toEqual([
      ["2026-07-03", 2],
      ["2026-07-01", 1],
    ]);
  });
});
