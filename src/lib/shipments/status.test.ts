import { describe, expect, it } from "vitest";

import { deriveShipmentStatus } from "./status";

const TODAY = "2026-08-06";

describe("deriveShipmentStatus", () => {
  it("booked: no sail date, no ETA, no entry", () => {
    expect(
      deriveShipmentStatus(
        { sailedOnBoardDate: null, eta: null },
        false,
        TODAY,
      ),
    ).toBe("booked");
  });

  it("booked: a future sail date proves nothing yet", () => {
    expect(
      deriveShipmentStatus(
        { sailedOnBoardDate: "2026-08-10", eta: null },
        false,
        TODAY,
      ),
    ).toBe("booked");
  });

  it("in_transit: the laden date has passed (inclusive)", () => {
    expect(
      deriveShipmentStatus(
        { sailedOnBoardDate: "2026-08-06", eta: "2026-08-20" },
        false,
        TODAY,
      ),
    ).toBe("in_transit");
    expect(
      deriveShipmentStatus(
        { sailedOnBoardDate: "2026-07-01", eta: null },
        false,
        TODAY,
      ),
    ).toBe("in_transit");
  });

  it("arrived: ETA has passed (inclusive), even without a sail date", () => {
    expect(
      deriveShipmentStatus(
        { sailedOnBoardDate: null, eta: "2026-08-06" },
        false,
        TODAY,
      ),
    ).toBe("arrived");
    expect(
      deriveShipmentStatus(
        { sailedOnBoardDate: "2026-07-01", eta: "2026-08-01" },
        false,
        TODAY,
      ),
    ).toBe("arrived");
  });

  it("arrived: a linked customs entry is direct evidence, ETA or not", () => {
    expect(
      deriveShipmentStatus({ sailedOnBoardDate: null, eta: null }, true, TODAY),
    ).toBe("arrived");
    expect(
      deriveShipmentStatus(
        { sailedOnBoardDate: "2026-07-01", eta: "2026-09-01" },
        true,
        TODAY,
      ),
    ).toBe("arrived");
  });

  it("a future ETA alone never advances past what the sail date proves", () => {
    expect(
      deriveShipmentStatus(
        { sailedOnBoardDate: null, eta: "2026-09-01" },
        false,
        TODAY,
      ),
    ).toBe("booked");
  });
});
