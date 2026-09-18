import { describe, expect, it } from "vitest";

import {
  mmrCoverageNotice,
  computeYDomain,
  mmrCalendarTime,
  formatMmrDate,
  type MmrCoverage,
} from "../MmrProgressionChart";

function coverage(overrides: Partial<MmrCoverage> = {}): MmrCoverage {
  return {
    filteredGames: 0,
    numericMmrGames: 0,
    verifiedReplayMmrGames: 0,
    untrustedNumericMmrGames: 0,
    unavailableMmrGames: 0,
    missingMmrGames: 0,
    excludedNonRanked1v1Games: 0,
    missingAccountGames: 0,
    missingLadderRaceGames: 0,
    eligibleGames: 0,
    ...overrides,
  };
}

describe("MMR progression coverage copy", () => {
  it("asks for a resync when legacy numeric MMR has no trusted source", () => {
    const notice = mmrCoverageNotice(
      coverage({ untrustedNumericMmrGames: 11_909 }),
    );

    expect(notice?.title).toBe("MMR history needs a resync");
    expect(notice?.sub).toContain("11,909 older numeric MMR records were excluded");
    expect(notice?.sub).toContain("ranked 1v1 replay ratings");
  });

  it("uses singular grammar and stays quiet when nothing was quarantined", () => {
    expect(
      mmrCoverageNotice(coverage({ untrustedNumericMmrGames: 1 }))?.sub,
    ).toContain("1 older numeric MMR record was excluded");
    expect(mmrCoverageNotice(coverage())).toBeNull();
    expect(mmrCoverageNotice(undefined)).toBeNull();
  });
});

describe("MMR progression scale", () => {
  it("formats numeric tooltip labels and Date-valued temporal ticks identically", () => {
    const date = new Date("2026-09-18T00:00:00Z");
    expect(formatMmrDate(date)).toBe("Sep 18");
    expect(formatMmrDate(date.getTime(), true)).toBe("Sep 18, 2026");
    expect(formatMmrDate("2026-09-18", true)).toBe("Sep 18, 2026");
  });

  it("keeps inactive calendar days in the horizontal spacing across daylight saving", () => {
    const before = mmrCalendarTime("2026-03-07T05:00:00Z", "America/New_York");
    const after = mmrCalendarTime("2026-03-10T04:00:00Z", "America/New_York");
    expect(after - before).toBe(3 * 86_400_000);
    expect(new Date(before).toISOString()).toBe("2026-03-07T00:00:00.000Z");
  });

  it("does not magnify a flat or tiny rating change into a full-height swing", () => {
    expect(computeYDomain([{ min: 4000, max: 4000 }])).toEqual([3930, 4070]);
    const domain = computeYDomain([{ min: 4000, max: 4020 }])!;
    expect(domain[1] - domain[0]).toBeGreaterThanOrEqual(140);
  });

  it("includes the observed rating range and does not dip below zero", () => {
    expect(computeYDomain([{ min: 0, max: 20 }])?.[0]).toBe(0);
    const domain = computeYDomain([{ min: 2900, max: 4800 }])!;
    expect(domain[0]).toBeLessThan(2900);
    expect(domain[1]).toBeGreaterThan(4800);
    expect(computeYDomain([])).toBeUndefined();
  });
});
