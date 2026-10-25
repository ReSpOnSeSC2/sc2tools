import { describe, expect, it } from "vitest";
import { privateScouting, projectDockScouting } from "./liveScouting";
import type { LiveGameEnvelope } from "@/components/overlay/types";
const live = (): LiveGameEnvelope => ({ type: "liveGameState", phase: "match_loading", capturedAt: 1, gameKey: "one", opponent: { name: "Opponent", race: "Zerg", profile: { mmr: 4200, league: "Master" } }, streamerHistory: { oppName: "Opponent", oppPulseId: "1-S2-1-42", opponentIdentityMatched: true, opponentNotesWritable: true, opponentNotes: { text: "private note", readAloud: false }, headToHead: { wins: 2, losses: 1 }, openingHistory: [{ name: "Hatch first", samples: 5, of: 7 }], recentGames: [{ gameId: "replay-42", result: "Win", lengthText: "8:01", map: "Map", myBuild: "Phoenix", oppBuild: "Hatch first" }] } });
describe("live scouting projection", () => {
  it("keeps every private field and replay identity out of the Dock model", () => {
    const value = live(), safe = projectDockScouting(value)!;
    expect(safe.openings).toEqual([{ name: "Hatch first", samples: 5, of: 7 }]);
    expect(safe.h2h).toEqual({ wins: 2, losses: 1 });
    for (const secret of ["private note", "1-S2-1-42", "replay-42", "opponentNotes", "recentGames", "pulseId"]) expect(JSON.stringify(safe)).not.toContain(secret);
    expect(privateScouting(value).pulseId).toBe("1-S2-1-42");
  });
  it("hides histories with a different direct identity or a legacy name-only match", () => {
    const value = live(); value.opponent!.name = "Different";
    expect(projectDockScouting(value)?.enriched).toBe(false); expect(privateScouting(value).note).toBe("");
    value.opponent!.name = "Opponent"; value.streamerHistory!.opponentIdentityMatched = false;
    expect(projectDockScouting(value)?.h2h).toBeNull(); expect(privateScouting(value).recent).toEqual([]);
  });
  it("does not show replay, ended or idle envelopes; retains first-meeting identity", () => {
    for (const phase of ["idle", "menu", "match_ended"] as const) expect(projectDockScouting({ ...live(), phase })).toBeNull();
    expect(projectDockScouting({ ...live(), isReplay: true })).toBeNull();
    const value = live(); value.streamerHistory!.headToHead = { wins: 0, losses: 0 };
    expect(projectDockScouting(value)).toMatchObject({ name: "Opponent", league: "Master", mmr: 4200, h2h: { wins: 0, losses: 0 } });
  });
  it("bounds malformed samples and uses saved MMR only as a fallback", () => {
    const value = live(); value.opponent!.profile!.mmr = 0; value.streamerHistory!.oppMmr = 4100;
    value.streamerHistory!.openingHistory = [{ name: "Invalid", samples: 6, of: 2 }];
    expect(projectDockScouting(value)).toMatchObject({ mmr: 4100, openings: [] });
  });
  it("rejects an old barcode history when the directly observed toon changes", () => {
    const value = live(); value.opponent!.toonHandle = "1-S2-1-99";
    expect(privateScouting(value).note).toBe(""); expect(privateScouting(value).pulseId).toBeNull();
    expect(projectDockScouting(value)?.enriched).toBe(false);
  });
});
