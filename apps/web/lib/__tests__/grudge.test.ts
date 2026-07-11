import { describe, expect, it } from "vitest";
import {
  buildGrudgeLine,
  grudgeInputFromLive,
  type GrudgeInput,
} from "../grudge";
import type { LiveGamePayload } from "@/components/overlay/types";

/** Base input helper — override only what a case cares about. */
function inp(over: Partial<GrudgeInput> = {}): GrudgeInput {
  return { opponentName: "Rival", opponentId: "rival-1", ...over };
}

describe("buildGrudgeLine — null / no-story cases", () => {
  it("returns null for null/undefined input", () => {
    expect(buildGrudgeLine(null)).toBeNull();
    expect(buildGrudgeLine(undefined)).toBeNull();
  });

  it("returns null for a first meeting with no history", () => {
    expect(buildGrudgeLine(inp())).toBeNull();
    expect(buildGrudgeLine(inp({ headToHead: { wins: 0, losses: 0 } }))).toBeNull();
  });

  it("returns null when a lone this-week meeting isn't a repeat yet", () => {
    expect(buildGrudgeLine(inp({ meetingsThisWeek: 1 }))).toBeNull();
  });

  it("does not treat a lone 'won last game' as a rivalry story", () => {
    expect(buildGrudgeLine(inp({ lastResult: "win" }))).toBeNull();
  });
});

describe("buildGrudgeLine — record scenarios", () => {
  it("NEMESIS when you're down 3+", () => {
    const g = buildGrudgeLine(inp({ headToHead: { wins: 1, losses: 5 } }));
    expect(g).not.toBeNull();
    expect(g!.tag).toBe("NEMESIS");
    // Copy states the record from the opponent's side: 5-1.
    expect(g!.line).toContain("5-1");
  });

  it("DOMINANT when you're up 3+", () => {
    const g = buildGrudgeLine(inp({ headToHead: { wins: 6, losses: 1 } }));
    expect(g).not.toBeNull();
    expect(g!.tag).toBe("DOMINANT");
    expect(g!.line).toContain("6-1");
  });

  it("AHEAD when leading by a small margin", () => {
    const g = buildGrudgeLine(inp({ headToHead: { wins: 3, losses: 1 } }));
    expect(g!.tag).toBe("AHEAD");
    expect(g!.line).toContain("3-1");
  });

  it("PAYBACK when behind by a small margin", () => {
    const g = buildGrudgeLine(inp({ headToHead: { wins: 1, losses: 3 } }));
    expect(g!.tag).toBe("PAYBACK");
    // Opponent-side record: 3-1.
    expect(g!.line).toContain("3-1");
  });

  it("DEAD EVEN on a tied series", () => {
    const g = buildGrudgeLine(inp({ headToHead: { wins: 2, losses: 2 } }));
    expect(g!.tag).toBe("DEAD EVEN");
    expect(g!.line).toContain("2-2");
  });
});

describe("buildGrudgeLine — revenge (you lost last)", () => {
  it("RUN IT BACK on a close record where you dropped the last game", () => {
    const g = buildGrudgeLine(
      inp({ headToHead: { wins: 1, losses: 1 }, lastResult: "loss" }),
    );
    expect(g!.tag).toBe("RUN IT BACK");
  });

  it("RUN IT BACK even with no head-to-head record, from lastResult alone", () => {
    const g = buildGrudgeLine(inp({ headToHead: null, lastResult: "loss" }));
    expect(g!.tag).toBe("RUN IT BACK");
  });

  it("folds the last build + same-map callback into the revenge line", () => {
    const g = buildGrudgeLine(
      inp({
        headToHead: { wins: 1, losses: 1 },
        lastResult: "loss",
        map: "Goldenaura",
        lastMap: "Goldenaura",
        lastOppBuild: "PvZ - Cannon Rush",
      }),
    );
    expect(g!.tag).toBe("RUN IT BACK");
    // Either variant references either the build or the same map.
    expect(/Cannon Rush|same map|this very map/i.test(g!.line)).toBe(true);
  });
});

describe("buildGrudgeLine — repeat-meeting hook", () => {
  it("REMATCH weaves record + last build + same-map (flagship shape)", () => {
    const g = buildGrudgeLine(
      inp({
        headToHead: { wins: 2, losses: 4 },
        lastResult: "loss",
        meetingsThisWeek: 3,
        map: "Goldenaura",
        lastMap: "Goldenaura",
        lastOppBuild: "PvZ - Cannon Rush",
      }),
    );
    expect(g!.tag).toBe("REMATCH");
    expect(g!.line).toContain("this week");
    expect(g!.line).toContain("4-2"); // opponent leads 4-2
    expect(g!.line).toContain("Cannon Rush");
    expect(g!.line).toContain("on this map");
  });

  it("prefers the same-day 'today' scope over the weekly one", () => {
    const g = buildGrudgeLine(
      inp({
        headToHead: { wins: 2, losses: 2 },
        meetingsThisSession: 2,
        meetingsThisWeek: 5,
      }),
    );
    expect(g!.tag).toBe("REMATCH");
    expect(g!.line).toContain("today");
    expect(g!.line).not.toContain("this week");
  });

  it("NEMESIS still outranks a repeat when the record is lopsided", () => {
    const g = buildGrudgeLine(
      inp({ headToHead: { wins: 0, losses: 4 }, meetingsThisWeek: 3 }),
    );
    expect(g!.tag).toBe("NEMESIS");
  });

  it("strips the matchup prefix from the opponent's build label", () => {
    const g = buildGrudgeLine(
      inp({
        headToHead: { wins: 2, losses: 4 },
        meetingsThisWeek: 2,
        lastOppBuild: "Zerg - 3 Base Macro (Hatch First)",
      }),
    );
    expect(g!.line).toContain("3 Base Macro (Hatch First)");
    expect(g!.line).not.toContain("Zerg -");
  });
});

describe("buildGrudgeLine — determinism & cross-opponent variance", () => {
  it("is stable: identical input renders an identical line", () => {
    const input = inp({ headToHead: { wins: 4, losses: 2 }, lastResult: "loss" });
    expect(buildGrudgeLine(input)).toEqual(buildGrudgeLine(input));
  });

  it("varies template across opponents in the same scenario", () => {
    const lines = new Set<string>();
    for (let i = 0; i < 24; i++) {
      const g = buildGrudgeLine({
        opponentName: "Foe", // constant copy → variance can only come from the variant pick
        opponentId: `opp-${i}`,
        headToHead: { wins: 3, losses: 1 },
      });
      if (g) lines.add(g.line);
    }
    // The AHEAD scenario has multiple variants; across 24 opponents we
    // must see more than one distinct rendering.
    expect(lines.size).toBeGreaterThan(1);
  });

  it("keeps the same opponent+standing on the same variant", () => {
    const a = buildGrudgeLine(inp({ headToHead: { wins: 3, losses: 1 } }));
    const b = buildGrudgeLine(inp({ headToHead: { wins: 3, losses: 1 } }));
    expect(a!.line).toBe(b!.line);
  });
});

describe("grudgeInputFromLive", () => {
  const NOW = Date.parse("2026-07-11T18:00:00Z");
  const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString();

  function live(over: Partial<LiveGamePayload> = {}): LiveGamePayload {
    return {
      oppName: "Clem",
      map: "Goldenaura",
      headToHead: { wins: 2, losses: 4 },
      recentGames: [
        {
          result: "Win",
          lengthText: "12:30",
          map: "Goldenaura",
          oppBuild: "PvZ - Cannon Rush",
          date: hoursAgo(25), // yesterday — within the week, not "today"
        },
        { result: "Loss", lengthText: "8:00", map: "Alcyone", date: hoursAgo(50) },
        // 10 days ago — outside the 7-day window.
        { result: "Loss", lengthText: "9:00", map: "Amphion", date: hoursAgo(24 * 10) },
      ],
      ...over,
    };
  }

  it("derives a weekly meeting count inclusive of the current game", () => {
    const gi = grudgeInputFromLive(live(), NOW);
    // Two recent games inside 7 days + this encounter = 3.
    expect(gi.meetingsThisWeek).toBe(3);
  });

  it("maps head-to-head, opponent name, map and last-meeting fields", () => {
    const gi = grudgeInputFromLive(live(), NOW);
    expect(gi.opponentName).toBe("Clem");
    expect(gi.opponentId).toBe("Clem");
    expect(gi.headToHead).toEqual({ wins: 2, losses: 4 });
    expect(gi.map).toBe("Goldenaura");
    expect(gi.lastMap).toBe("Goldenaura");
    expect(gi.lastOppBuild).toBe("PvZ - Cannon Rush");
  });

  it("prefers rematch.lastResult over the newest recent game's result", () => {
    const gi = grudgeInputFromLive(
      live({ rematch: { isRematch: true, lastResult: "loss" } }),
      NOW,
    );
    // rematch says loss even though the newest recent game is a Win.
    expect(gi.lastResult).toBe("loss");
  });

  it("falls back to the newest recent game's result when rematch is absent", () => {
    const gi = grudgeInputFromLive(live(), NOW);
    expect(gi.lastResult).toBe("win");
  });

  it("falls back to rival.headToHead / rival.name when top-level absent", () => {
    const gi = grudgeInputFromLive(
      {
        rival: { name: "Serral", headToHead: { wins: 1, losses: 6 } },
      } as LiveGamePayload,
      NOW,
    );
    expect(gi.opponentName).toBe("Serral");
    expect(gi.headToHead).toEqual({ wins: 1, losses: 6 });
  });

  it("produces null meeting counts and no grudge for an empty payload", () => {
    const gi = grudgeInputFromLive({} as LiveGamePayload, NOW);
    expect(gi.meetingsThisWeek).toBeNull();
    expect(gi.meetingsThisSession).toBeNull();
    expect(buildGrudgeLine(gi)).toBeNull();
  });

  it("end-to-end: a rich live payload yields a coherent REMATCH line", () => {
    const gi = grudgeInputFromLive(
      live({ rematch: { isRematch: true, lastResult: "loss" } }),
      NOW,
    );
    const g = buildGrudgeLine(gi);
    expect(g).not.toBeNull();
    expect(g!.tag).toBe("REMATCH");
    expect(g!.line).toContain("this week");
  });
});
