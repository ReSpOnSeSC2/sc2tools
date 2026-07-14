import { describe, expect, it } from "vitest";

import {
  mmrCoverageNotice,
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
