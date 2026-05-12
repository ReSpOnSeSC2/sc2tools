import { describe, expect, test } from "vitest";
import { __test, bingoLadder } from "../modes/games/bingoLadder";
import { mulberry32 } from "../ArcadeEngine";
import type { ArcadeDataset, ArcadeGame, BingoState } from "../types";

const { buildCard, isLegacyCard, LEGACY_PREDICATES } = __test;

/**
 * Synthesise a tiny but plausible dataset for a Protoss player who
 * also dabbles in Zerg. The bingo generator gates race-bound
 * candidates on which races the user actually played in the last
 * 30 days, so we need at least one game per race we want to assert
 * about.
 */
function datasetForRaces(races: string[]): ArcadeDataset {
  const now = Date.now();
  const games: ArcadeGame[] = races.map((r, i) => ({
    gameId: `g-${i}`,
    date: new Date(now - i * 24 * 60 * 60 * 1000).toISOString(),
    result: "Victory",
    myRace: r,
  }));
  return {
    games,
    opponents: [],
    builds: [],
    customBuilds: [],
    communityBuilds: [],
    matchups: [],
    maps: [],
    summary: null,
    // Map pool is irrelevant now that map cells are gone — passing
    // a non-empty list pins the regression that previously made the
    // generator emit "Win on <map>" cells.
    mapPool: ["Equilibrium", "Frostline", "Site Delta"],
  };
}

describe("bingoLadder card generation", () => {
  test("emits 25 cells with the free space at index 12", async () => {
    const out = await bingoLadder.generate({
      rng: mulberry32(1),
      daySeed: "2026-05-11",
      tz: "UTC",
      data: datasetForRaces(["Protoss"]),
    });
    expect(out.ok).toBe(true);
    if (!out.ok) throw new Error("unreachable — narrowed above");
    expect(out.question.cells).toHaveLength(25);
    expect(out.question.cells[12].predicate).toBe("any_game");
    expect(out.question.cells[12].label).toMatch(/free space/i);
  });

  test("no card cell uses the retired win_on_map predicate", async () => {
    // The May-2026 overhaul removed per-map objectives entirely.
    // Both the generator and any cell labeling must drop them.
    const out = await bingoLadder.generate({
      rng: mulberry32(42),
      daySeed: "2026-05-11",
      tz: "UTC",
      data: datasetForRaces(["Protoss", "Zerg", "Terran"]),
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    for (const cell of out.question.cells) {
      expect(cell.predicate).not.toBe("win_on_map");
      expect(cell.label.toLowerCase()).not.toMatch(/^win on /);
    }
  });

  test("no duplicate cell predicate+params combinations on a single card", () => {
    // The screenshot the user reported showed a card with two
    // ostensibly-identical "Win as Protoss" cells. Cause: the
    // candidate list could contain dup-key entries (e.g. when a
    // race appeared in both racesPlayed and the vs-pool). buildCard
    // now dedupes by `<predicate>:<params>` before pickN, so two
    // cells with the same key can't ride along to the same card.
    const cells = buildCard(
      {
        rng: mulberry32(7),
        daySeed: "2026-05-11",
        tz: "UTC",
        data: datasetForRaces(["Protoss", "Zerg", "Terran"]),
      },
      "2026-W19",
      new Set(["P", "Z", "T"]),
    );
    const seenKeys = new Set<string>();
    for (const c of cells) {
      const k = `${c.predicate}::${JSON.stringify(c.params)}`;
      expect(seenKeys.has(k), `duplicate key ${k}`).toBe(false);
      seenKeys.add(k);
    }
  });

  test("race-bound 'win as X' candidates only appear for races the user played", () => {
    const cells = buildCard(
      {
        rng: mulberry32(2),
        daySeed: "2026-05-11",
        tz: "UTC",
        data: datasetForRaces(["Protoss"]),
      },
      "2026-W19",
      new Set(["P"]),
    );
    // We can't assert "win as Protoss" is on every card (pickN is
    // random) but we CAN assert no win_as_race cell references Z/T
    // when the user hasn't touched those races.
    for (const c of cells) {
      if (c.predicate === "win_as_race") {
        expect(c.params.race).toBe("P");
      }
    }
  });

  test("no card cell mints the retired Expand-opener win predicate", () => {
    // ``win_build_contains`` with keyword "Expand" was retired in the
    // May-2026 follow-up overhaul — the agent's strategy classifier
    // has no stable label for "expand opener", so the cell was
    // unwinnable on every card it appeared on. The predicate itself
    // is still alive (Cannon Rush / Proxy / All-in / etc.), so we
    // assert by inspecting the params.
    for (let seed = 0; seed < 30; seed += 1) {
      const cells = buildCard(
        {
          rng: mulberry32(seed),
          daySeed: "2026-05-11",
          tz: "UTC",
          data: datasetForRaces(["Protoss", "Zerg", "Terran"]),
        },
        "2026-W19",
        new Set(["P", "Z", "T"]),
      );
      for (const c of cells) {
        if (c.predicate !== "win_build_contains") continue;
        const kw = String(c.params.keyword || "").toLowerCase();
        expect(kw).not.toBe("expand");
        expect(c.label.toLowerCase()).not.toMatch(/expand opener/);
      }
    }
  });

  test("built_n_of_unit_week candidates are minted for races the user plays", () => {
    // The "build N this week" objectives are race-specific (the
    // candidate list gates on racePool) — a pure Protoss player
    // should never see a "build 100 Marines this week" cell. We
    // sweep enough seeds to make a missing race assertion
    // statistically informative.
    const seenForProtoss = new Set<string>();
    for (let seed = 0; seed < 30; seed += 1) {
      const cells = buildCard(
        {
          rng: mulberry32(seed),
          daySeed: "2026-05-11",
          tz: "UTC",
          data: datasetForRaces(["Protoss"]),
        },
        "2026-W19",
        new Set(["P"]),
      );
      for (const c of cells) {
        if (c.predicate !== "built_n_of_unit_week") continue;
        seenForProtoss.add(String(c.params.unit));
      }
    }
    // A Protoss-only player must not see Marine / Roach cells.
    expect(seenForProtoss.has("Marine")).toBe(false);
    expect(seenForProtoss.has("Roach")).toBe(false);
    // They SHOULD see Protoss-only cells across enough seeds.
    const protossOnly = ["Zealot", "Stalker", "Immortal"].filter((u) =>
      seenForProtoss.has(u),
    );
    expect(protossOnly.length).toBeGreaterThan(0);
  });

  test("vs-race candidates cover all three races, regardless of what the user plays", () => {
    // The user can't choose their opponent's race, so "vs Z/T/P"
    // candidates are always in the pool. We test by exhausting the
    // candidate list — buildCard returns 25 cells from the dedup'd
    // candidate pool, so checking that all three vs-race targets
    // appear across enough seeds is overkill. Instead, peek at
    // the candidate pool directly via a multi-seed sweep.
    const seenVsRaces = new Set<string>();
    for (let seed = 0; seed < 20; seed += 1) {
      const cells = buildCard(
        {
          rng: mulberry32(seed),
          daySeed: "2026-05-11",
          tz: "UTC",
          data: datasetForRaces(["Protoss"]),
        },
        "2026-W19",
        new Set(["P"]),
      );
      for (const c of cells) {
        if (c.predicate === "win_vs_race") {
          seenVsRaces.add(String(c.params.race));
        }
      }
    }
    expect(seenVsRaces).toContain("P");
    expect(seenVsRaces).toContain("T");
    expect(seenVsRaces).toContain("Z");
  });

  test("generate returns ok=false when the user hasn't played any games (no synth)", async () => {
    const out = await bingoLadder.generate({
      rng: mulberry32(1),
      daySeed: "2026-05-11",
      tz: "UTC",
      data: datasetForRaces([]),
    });
    expect(out.ok).toBe(false);
  });

  test("generate ALLOWS an empty mapPool — the analyzer no longer requires it", async () => {
    // The previous gate required mapPool.length > 0, which silently
    // blocked card generation for users on regions/seasons where the
    // /v1/seasons map list was empty. Removing map cells means we
    // no longer need that signal.
    const data = datasetForRaces(["Zerg"]);
    data.mapPool = [];
    const out = await bingoLadder.generate({
      rng: mulberry32(1),
      daySeed: "2026-05-11",
      tz: "UTC",
      data,
    });
    expect(out.ok).toBe(true);
  });
});

describe("bingoLadder legacy card detection", () => {
  test("isLegacyCard returns true when ANY cell references a retired predicate", () => {
    const legacy: BingoState = {
      startedAt: new Date().toISOString(),
      weekKey: "2026-W19",
      rerolled: false,
      cells: [
        {
          id: "a",
          predicate: "win_on_map",
          params: { map: "Equilibrium" },
          label: "Win on Equilibrium",
          ticked: false,
        },
        {
          id: "b",
          predicate: "win_as_race",
          params: { race: "P" },
          label: "Win as Protoss",
          ticked: true,
        },
      ],
    };
    expect(isLegacyCard(legacy)).toBe(true);
  });

  test("isLegacyCard returns false for cards that only use current predicates", () => {
    const fresh: BingoState = {
      startedAt: new Date().toISOString(),
      weekKey: "2026-W19",
      rerolled: false,
      cells: [
        {
          id: "a",
          predicate: "macro_above",
          params: { minScore: 70 },
          label: "Hit macro score 70+",
          ticked: false,
        },
      ],
    };
    expect(isLegacyCard(fresh)).toBe(false);
  });

  test("LEGACY_PREDICATES includes win_on_map (the removed per-map predicate)", () => {
    expect(LEGACY_PREDICATES.has("win_on_map")).toBe(true);
  });

  test("isLegacyCard tolerates null / empty cells without throwing", () => {
    expect(isLegacyCard(null)).toBe(false);
    expect(
      isLegacyCard({
        startedAt: "",
        weekKey: "",
        rerolled: false,
        cells: [],
      }),
    ).toBe(false);
  });

  test("isLegacyCard flags cards minted with the retired Expand-opener keyword", () => {
    // The predicate ``win_build_contains`` is still alive (Cannon Rush
    // / Proxy / All-in / etc.) — only the "Expand" keyword variant is
    // retired. Without the (predicate, paramKey) check, every card
    // carrying any win_build_contains cell would reset every Monday
    // morning, which would be a worse UX than the original bug.
    const expanded: BingoState = {
      startedAt: new Date().toISOString(),
      weekKey: "2026-W19",
      rerolled: false,
      cells: [
        {
          id: "a",
          predicate: "win_build_contains",
          params: { keyword: "Expand" },
          label: "Win with an Expand opener",
          ticked: false,
        },
      ],
    };
    expect(isLegacyCard(expanded)).toBe(true);
    // A card with a different win_build_contains keyword must NOT be
    // flagged legacy.
    const cannon: BingoState = {
      ...expanded,
      cells: [
        {
          id: "a",
          predicate: "win_build_contains",
          params: { keyword: "Cannon Rush" },
          label: "Win with a Cannon Rush",
          ticked: false,
        },
      ],
    };
    expect(isLegacyCard(cannon)).toBe(false);
  });
});
