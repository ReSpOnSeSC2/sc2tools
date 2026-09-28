import { describe, expect, it } from "vitest";
import { detectMe, type MeScan } from "../meDetection";
import type { ReplayPlayer } from "../types";

const ME = "1-S2-1-267727";
const ALT = "2-S2-1-111";

function player(name: string, toon: string | null, race = "Protoss", pid = 1): ReplayPlayer {
  return { name, toon, race, result: "Win", pid };
}

function scan(key: string, players: ReplayPlayer[], toonFromPath: string | null = null): MeScan {
  return { key, players, toonFromPath };
}

describe("detectMe", () => {
  it("uses the toon from the path exactly (desktop agent rule)", () => {
    const scans = [
      scan("a", [player("Me", ME), player("Opp", "1-S2-1-9", "Zerg", 2)], ME),
      scan("b", [player("Opp2", "1-S2-1-8"), player("Me", ME, "Protoss", 2)], ME),
    ];
    const result = detectMe(scans);
    expect(result.mode).toBe("path");
    expect(result.needsConfirmation).toBe(false);
    expect(result.candidates).toEqual([{ toon: ME, name: "Me", race: "Protoss", games: 2 }]);
    expect(result.selectorFor("b")).toEqual({ toon: ME, handle: "Me" });
    // A path toon is authoritative even if the visitor picks someone else.
    expect(result.selectorFor("b", "1-S2-1-8")).toEqual({ toon: ME, handle: "Me" });
  });

  it("returns a null selector when the path toon did not play", () => {
    const result = detectMe([scan("a", [player("X", "1-S2-1-1"), player("Y", "1-S2-1-2")], ME)]);
    expect(result.selectorFor("a")).toBeNull();
  });

  it("matches a saved profile toon when the path has none", () => {
    const scans = [scan("a", [player("Opp", "1-S2-1-9"), player("Me", ME)])];
    const result = detectMe(scans, { profileToons: [ME, ALT] });
    expect(result.mode).toBe("profile");
    expect(result.needsConfirmation).toBe(false);
    expect(result.selectorFor("a")).toEqual({ toon: ME, handle: "Me" });
  });
});

describe("detectMe: batch majority", () => {
  it("proposes the batch majority (>= 60%) for one-tap confirmation", () => {
    const scans = [
      scan("1", [player("Me", ME), player("A", "1-S2-1-1", "Zerg")]),
      scan("2", [player("Me", ME), player("B", "1-S2-1-2", "Terran")]),
      scan("3", [player("MeClan", ME), player("C", "1-S2-1-3", "Zerg")]),
      scan("4", [player("D", "1-S2-1-4"), player("E", "1-S2-1-5")]),
      scan("5", [player("Me", ME, "Zerg"), player("F", "1-S2-1-6")]),
    ];
    const result = detectMe(scans);
    expect(result.mode).toBe("majority");
    expect(result.needsConfirmation).toBe(true);
    expect(result.candidates[0]).toEqual({ toon: ME, name: "Me", race: "Protoss", games: 4 });
    expect(result.selectorFor("1")).toEqual({ toon: ME, handle: "Me" });
    expect(result.selectorFor("3")).toEqual({ toon: ME, handle: "MeClan" });
    // The chosen toon did not play in file 4 -> skip as player_unresolved.
    expect(result.selectorFor("4")).toBeNull();
    // The visitor may pick another candidate instead.
    expect(result.selectorFor("4", "1-S2-1-4")).toEqual({ toon: "1-S2-1-4", handle: "D" });
  });
});

describe("detectMe: ambiguous batches", () => {
  it("is ambiguous below the threshold", () => {
    const scans = [
      scan("1", [player("Me", ME), player("A", "1-S2-1-1")]),
      scan("2", [player("B", "1-S2-1-2"), player("C", "1-S2-1-3")]),
      scan("3", [player("D", "1-S2-1-4"), player("Me", ME)]),
      scan("4", [player("E", "1-S2-1-5"), player("F", "1-S2-1-6")]),
    ];
    const result = detectMe(scans);
    expect(result.mode).toBe("ambiguous");
    expect(result.candidates[0].toon).toBe(ME);
    expect(result.selectorFor("1")).toBeNull();
  });

  it("is ambiguous for a single loose file, offering both players", () => {
    const result = detectMe([scan("a", [player("Zed", ME), player("Amy", ALT, "Zerg", 2)])]);
    expect(result.mode).toBe("ambiguous");
    expect(result.needsConfirmation).toBe(true);
    expect(result.candidates.map((c) => c.toon).sort()).toEqual([ALT, ME].sort());
    expect(result.selectorFor("a")).toBeNull();
    expect(result.selectorFor("a", ALT)).toEqual({ toon: ALT, handle: "Amy" });
  });

  it("is ambiguous on a tie (same two players in every file)", () => {
    const scans = [
      scan("1", [player("Me", ME), player("Rival", ALT, "Terran")]),
      scan("2", [player("Rival", ALT, "Terran"), player("Me", ME)]),
    ];
    const result = detectMe(scans);
    expect(result.mode).toBe("ambiguous");
    expect(result.candidates.map((c) => c.games)).toEqual([2, 2]);
  });

  it("reports none when no player has a toon", () => {
    const result = detectMe([scan("a", [player("A", null), player("B", null)])]);
    expect(result.mode).toBe("none");
    expect(result.candidates).toEqual([]);
    expect(result.selectorFor("a", ME)).toBeNull();
    expect(result.selectorFor("missing")).toBeNull();
  });

  it("respects a custom threshold", () => {
    const scans = [
      scan("1", [player("Me", ME), player("A", "1-S2-1-1")]),
      scan("2", [player("Me", ME), player("B", "1-S2-1-2")]),
      scan("3", [player("C", "1-S2-1-3"), player("D", "1-S2-1-4")]),
    ];
    expect(detectMe(scans, { threshold: 0.6 }).mode).toBe("majority");
    expect(detectMe(scans, { threshold: 0.9 }).mode).toBe("ambiguous");
  });
});
