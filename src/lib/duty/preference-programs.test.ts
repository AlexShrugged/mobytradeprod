import { describe, expect, it } from "vitest";

import { lapsedProgram, type PreferenceLapse } from "./preference-programs";

describe("lapsedProgram", () => {
  it("GSP is lapsed from 2021-01-01, under every marker the schedule prints", () => {
    expect(lapsedProgram("A", "2025-05-08")?.program).toBe("GSP");
    expect(lapsedProgram("A*", "2025-05-08")?.program).toBe("GSP");
    expect(lapsedProgram("A+", "2021-01-01")?.program).toBe("GSP");
    expect(lapsedProgram(" a ", "2026-09-24")?.program).toBe("GSP");
  });

  it("was in force through 2020-12-31", () => {
    expect(lapsedProgram("A", "2020-12-31")).toBeNull();
    expect(lapsedProgram("A", "2019-06-01")).toBeNull();
  });

  it("says nothing about programs it does not track, or without an entry date", () => {
    expect(lapsedProgram("KR", "2025-05-08")).toBeNull();
    expect(lapsedProgram("S", "2025-05-08")).toBeNull();
    expect(lapsedProgram("", "2025-05-08")).toBeNull();
    expect(lapsedProgram("A", null)).toBeNull();
  });

  it("a closed lapse window ends the day before reauthorization", () => {
    const lapses: PreferenceLapse[] = [
      { program: "GSP", spis: ["A"], from: "2021-01-01", to: "2027-03-31", source: "test" },
    ];
    expect(lapsedProgram("A", "2027-03-31", lapses)?.program).toBe("GSP");
    expect(lapsedProgram("A", "2027-04-01", lapses)).toBeNull();
  });
});
