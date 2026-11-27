import { describe, expect, it } from "vitest";
import { GUARDIAN_COPY, minutesActive, readGuardian } from "../streamGuardian";

describe("readGuardian", () => {
  it("keeps the four known rules once each, in the order sent", () => {
    const rows = Object.keys(GUARDIAN_COPY).map((rule, index) => ({ rule, since: index + 1 }));
    expect(readGuardian({ warnings: [...rows, { rule: "mic_muted", since: 99 }] })).toEqual(rows);
  });

  it("ignores unknown rules, junk rows and a start time that is not a number", () => {
    expect(readGuardian({ warnings: [{ rule: "toString", since: 1 }, { rule: "x" }, null, 5, { rule: "stream_unstable", since: "soon" }] }))
      .toEqual([{ rule: "stream_unstable", since: 0 }]);
  });

  it.each([null, undefined, [], "warnings", 3, {}, { warnings: "mic_muted" }])("reads %j as no warnings", (raw) => {
    expect(readGuardian(raw)).toEqual([]);
  });
});

describe("minutesActive", () => {
  it("rounds to whole minutes and never says zero", () => {
    expect(minutesActive(0, 20_000)).toBe(1);
    expect(minutesActive(0, 5 * 60_000 + 20_000)).toBe(5);
    expect(minutesActive(60_000, 0)).toBe(1);
  });
});
