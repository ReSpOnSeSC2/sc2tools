import { describe, expect, it } from "vitest";
import { claimPath, DEFAULT_CLAIM, readClaimFragment } from "./selection";

const pin = { season: 68, asOf: "2026-11-13" };

describe("pinned balance receipt fragments", () => {
  it("retains the exact date, matchup side, cohort, and optional map", () => {
    const selection = { ...DEFAULT_CLAIM, race: "T" as const, cohort: "diamond", mapId: 45 };
    const path = claimPath(pin, selection);
    expect(path).toBe("/balance/claim#season=68&asOf=2026-11-13&matchup=pvt&tier=diamond&race=T&map=45");
    expect(readClaimFragment(path.slice(path.indexOf("#")))).toEqual({ pin, selection });
  });

  it.each(["matchup=pvp", "tier=grandmaster-1", "race=Z", "map=1.5", "map=9007199254740993", "map=4&map=5"])("rejects malformed fields %s", input => {
    const [key] = input.split("=", 1);
    const fields = new URLSearchParams(claimPath(pin, DEFAULT_CLAIM).split("#", 2)[1]);
    fields.delete(key);
    expect(readClaimFragment(`#${fields.toString()}&${input}`)).toBeNull();
  });
});
