import { describe, expect, it } from "vitest";
import {
  anonymousOpponent,
  knownMmr,
  letteredLabel,
  MAX_PLAUSIBLE_MMR,
  MIN_PLAUSIBLE_MMR,
  rivalLabel,
  roundedMmrGap,
  sharedDay,
  SHARED_MMR_GAP_STEP,
} from "../sharePrivacy";

describe("letteredLabel / rivalLabel", () => {
  it("letters items from A", () => {
    expect(letteredLabel("Game", 0)).toBe("Game A");
    expect(letteredLabel("Loss", 2)).toBe("Loss C");
    expect(rivalLabel(0)).toBe("Rival A");
    expect(rivalLabel(3)).toBe("Rival D");
  });

  it("counts past Z instead of running out of letters", () => {
    expect(rivalLabel(25)).toBe("Rival Z");
    expect(rivalLabel(26)).toBe("Rival 27");
  });

  it("gives every index on a card a different label", () => {
    const labels = Array.from({ length: 40 }, (_, i) => rivalLabel(i));
    expect(new Set(labels).size).toBe(40);
  });

  it("falls back to the first label for a bad index", () => {
    expect(rivalLabel(-1)).toBe("Rival A");
    expect(rivalLabel(1.5)).toBe("Rival A");
    expect(rivalLabel(Number.NaN)).toBe("Rival A");
  });
});

describe("anonymousOpponent", () => {
  it("describes an opponent by race only", () => {
    expect(anonymousOpponent("Zerg")).toBe("a Zerg opponent");
    expect(anonymousOpponent("p")).toBe("a Protoss opponent");
    expect(anonymousOpponent(" Terran ")).toBe("a Terran opponent");
    expect(anonymousOpponent("R")).toBe("a Random opponent");
  });

  it("says just 'an opponent' when the race is unknown", () => {
    expect(anonymousOpponent(null)).toBe("an opponent");
    expect(anonymousOpponent(undefined)).toBe("an opponent");
    expect(anonymousOpponent("")).toBe("an opponent");
    expect(anonymousOpponent("Unknown")).toBe("an opponent");
  });
});

describe("knownMmr", () => {
  it("accepts a real ladder rating", () => {
    expect(knownMmr(4100)).toBe(4100);
    expect(knownMmr(MIN_PLAUSIBLE_MMR)).toBe(500);
    expect(knownMmr(MAX_PLAUSIBLE_MMR)).toBe(9999);
  });

  it("treats 0 and anything else outside the ladder range as not recorded", () => {
    // 0 is the wire's "not recorded" value; 1 to 7 look like old league
    // numbers. Used as a rating, any of them turns a gap into the other
    // player's own rating.
    for (const value of [0, 1, 7, 499, 10000, -4200]) expect(knownMmr(value)).toBeNull();
  });

  it("rejects everything that is not a finite number", () => {
    for (const value of [null, undefined, "4100", Number.NaN, Number.POSITIVE_INFINITY, {}, true]) {
      expect(knownMmr(value)).toBeNull();
    }
  });
});

describe("sharedDay", () => {
  const AT = "2026-11-06T22:05:42Z";

  it("gives the day in the viewer's own time zone", () => {
    expect(sharedDay(AT)).toBe(
      new Date(AT).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }),
    );
    expect(sharedDay(AT)).toContain("2026");
  });

  it("never includes the time of day", () => {
    const local = new Date(AT);
    const minutes = String(local.getMinutes()).padStart(2, "0");
    const seconds = String(local.getSeconds()).padStart(2, "0");
    for (const input of [AT, local, local.getTime()]) {
      const day = sharedDay(input);
      expect(day).not.toMatch(/\d:\d\d/);
      expect(day).not.toContain(`${minutes}:${seconds}`);
    }
  });

  it("returns a dash for a missing or unreadable date", () => {
    for (const value of [null, undefined, "", "not a date"]) expect(sharedDay(value)).toBe("—");
  });
});

describe("roundedMmrGap", () => {
  it("rounds to the nearest 100", () => {
    expect(SHARED_MMR_GAP_STEP).toBe(100);
    expect(roundedMmrGap(212)).toBe(200);
    expect(roundedMmrGap(-188)).toBe(-200);
    expect(roundedMmrGap(100)).toBe(100);
  });

  it("treats +50 and -50 alike (half away from zero)", () => {
    expect(roundedMmrGap(50)).toBe(100);
    expect(roundedMmrGap(-50)).toBe(-100);
    expect(roundedMmrGap(49)).toBe(0);
    expect(roundedMmrGap(-49)).toBe(0);
  });

  it("never returns negative zero or a non-number", () => {
    expect(Object.is(roundedMmrGap(-10), 0)).toBe(true);
    expect(roundedMmrGap(Number.NaN)).toBe(0);
    expect(roundedMmrGap(Number.POSITIVE_INFINITY)).toBe(0);
  });

  it("leaves at least a 100-wide band for the other player's rating", () => {
    // Every exact gap in [150, 250) prints as 200, so the printed value
    // plus the sharer's own rating cannot pin the opponent's.
    const printed = new Set<number>();
    for (let gap = 150; gap < 250; gap += 1) printed.add(roundedMmrGap(gap));
    expect([...printed]).toEqual([200]);
  });
});
