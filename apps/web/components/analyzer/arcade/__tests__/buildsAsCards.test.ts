import { describe, expect, test } from "vitest";
import {
  buildUniverse,
  userEmittableCatalogEntry,
  userPlayedRaces,
} from "../sessions";
import { BUILD_DEFINITIONS } from "@/lib/build-definitions";
import type { ArcadeDataset, ArcadeGame } from "../types";

const baseDataset: ArcadeDataset = {
  games: [],
  opponents: [],
  builds: [],
  customBuilds: [],
  communityBuilds: [],
  matchups: [],
  maps: [],
  summary: null,
  mapPool: [],
};

// A protoss-main game with a matchup-prefixed myBuild — exactly the
// shape the cloud agent serialises into MongoDB after
// UserBuildDetector.detect_my_build() resolves a PvX rule.
function game(
  myBuild: string,
  myRace: "Protoss" | "Terran" | "Zerg",
): ArcadeGame {
  return {
    gameId: `g-${myBuild}`,
    date: "2026-05-01T00:00:00Z",
    result: "Victory",
    myRace,
    oppRace: "Protoss",
    duration: 600,
    map: "Goldenaura",
    myBuild,
  };
}

describe("userPlayedRaces", () => {
  test("collapses to the single race a main has piloted", () => {
    const data: ArcadeDataset = {
      ...baseDataset,
      games: [
        game("PvP - 2 Gate Expand", "Protoss"),
        game("PvT - Phoenix into Robo", "Protoss"),
        game("PvZ - Standard Blink Macro", "Protoss"),
      ],
    };
    const races = userPlayedRaces(data);
    expect(races.size).toBe(1);
    expect(races.has("Protoss")).toBe(true);
  });

  test("captures every race an off-race dabbler has touched", () => {
    const data: ArcadeDataset = {
      ...baseDataset,
      games: [
        game("PvP - 2 Gate Expand", "Protoss"),
        game("Unclassified - Terran", "Terran"),
        game("Unclassified - Zerg", "Zerg"),
      ],
    };
    const races = userPlayedRaces(data);
    expect(races.size).toBe(3);
    expect(races.has("Protoss")).toBe(true);
    expect(races.has("Terran")).toBe(true);
    expect(races.has("Zerg")).toBe(true);
  });

  test("falls back to inferring race from /v1/builds prefixes when games[].myRace is empty", () => {
    // Legacy ingestion paths sometimes dropped the per-game myRace
    // projection but still wrote the matchup-prefixed myBuild; we
    // must still resolve the user's race so the binder filter
    // doesn't collapse to "no races → fall back to every catalog row".
    const data: ArcadeDataset = {
      ...baseDataset,
      games: [
        { ...game("PvT - Phoenix into Robo", "Protoss"), myRace: undefined },
      ],
      builds: [
        { name: "PvT - Phoenix into Robo", total: 9, wins: 6, losses: 3, winRate: 0.67 },
      ],
    };
    const races = userPlayedRaces(data);
    expect(races.has("Protoss")).toBe(true);
  });

  test("returns the empty set when the user has no games yet", () => {
    expect(userPlayedRaces(baseDataset).size).toBe(0);
  });
});

describe("userEmittableCatalogEntry", () => {
  const protossOnly = new Set<"Protoss" | "Terran" | "Zerg" | "Random">([
    "Protoss",
  ]);

  test("drops the race-prefixed Protoss catalog rows (opponent-only)", () => {
    const robo = BUILD_DEFINITIONS.find(
      (d) => d.name === "Protoss - Robo Opener",
    )!;
    expect(robo.matchup).toBeNull();
    expect(userEmittableCatalogEntry(robo, protossOnly)).toBe(false);
  });

  test("keeps matchup-prefixed PvX rows for a Protoss main", () => {
    const pvp = BUILD_DEFINITIONS.find((d) => d.name === "PvP - 2 Gate Expand")!;
    expect(pvp.matchup).toBe("PvP");
    expect(userEmittableCatalogEntry(pvp, protossOnly)).toBe(true);
  });

  test("drops cross-race matchup rows the user can never emit (TvP for Protoss main)", () => {
    const tvp = BUILD_DEFINITIONS.find((d) => d.name === "TvP - 1-1-1 One Base")!;
    expect(tvp.matchup).toBe("TvP");
    expect(tvp.race).toBe("Terran");
    expect(userEmittableCatalogEntry(tvp, protossOnly)).toBe(false);
  });

  test("drops Terran-generic / Zerg-generic catalog rows for a Protoss main", () => {
    const terran = BUILD_DEFINITIONS.find(
      (d) => d.name === "Terran - 1-1-1 Standard",
    )!;
    const zerg = BUILD_DEFINITIONS.find((d) => d.name === "Zerg - 12 Pool")!;
    expect(userEmittableCatalogEntry(terran, protossOnly)).toBe(false);
    expect(userEmittableCatalogEntry(zerg, protossOnly)).toBe(false);
  });

  test("rejects every catalog row when the user race set is empty (fresh account)", () => {
    // A brand-new account with no games yet — the binder's empty
    // state message ("Play a few games and we'll start unlocking
    // your card binder.") takes over. Seeding the catalog with
    // arbitrary cross-race rows for a fresh account would mean the
    // user sees a binder full of locked Terran/Zerg/Protoss strategies
    // before they've played a single game.
    const empty = new Set<"Protoss" | "Terran" | "Zerg" | "Random">();
    const pvp = BUILD_DEFINITIONS.find((d) => d.name === "PvP - 2 Gate Expand")!;
    const robo = BUILD_DEFINITIONS.find(
      (d) => d.name === "Protoss - Robo Opener",
    )!;
    expect(userEmittableCatalogEntry(pvp, empty)).toBe(false);
    expect(userEmittableCatalogEntry(robo, empty)).toBe(false);
  });
});

describe("Builds-as-Cards: universe filtering", () => {
  test("Protoss main: binder drops the 17 Protoss-generic opponent-only stubs", () => {
    // Before the filter: a Protoss main saw 17 race-prefixed
    // Protoss catalog stubs (Protoss - Robo Opener, Protoss - Glaive
    // Adept Timing, …) that the user-side detector can never emit as
    // their myBuild. After the filter: those rows are gone, so the
    // forever-locked denominator the user complained about
    // ("117/119 but I can see way more than 2 not played") collapses
    // to a closeable one.
    const protossPlays: ArcadeDataset = {
      ...baseDataset,
      games: [game("PvP - 2 Gate Expand", "Protoss")],
      builds: [
        { name: "PvP - 2 Gate Expand", total: 10, wins: 5, losses: 5, winRate: 0.5 },
      ],
    };
    const races = userPlayedRaces(protossPlays);
    const u = buildUniverse(protossPlays, {
      includeCatalog: true,
      catalogFilter: (def) => userEmittableCatalogEntry(def, races),
    });
    const names = u.map((b) => b.name);

    // Race-prefixed Protoss rows are stripped.
    expect(names).not.toContain("Protoss - Robo Opener");
    expect(names).not.toContain("Protoss - Glaive Adept Timing");
    expect(names).not.toContain("Protoss - Proxy 4 Gate");
    expect(names).not.toContain("Protoss - 4 Gate Rush");

    // Cross-race matchups are stripped (a Protoss main never emits
    // TvP, ZvZ, etc. as myBuild).
    expect(names).not.toContain("TvP - 1-1-1 One Base");
    expect(names).not.toContain("TvP - Game Too Short");
    expect(names).not.toContain("ZvZ - Game Too Short");

    // Terran and Zerg generic stubs are stripped.
    expect(names).not.toContain("Terran - 1-1-1 Standard");
    expect(names).not.toContain("Zerg - 12 Pool");

    // Matchup-specific Protoss rows the user CAN emit survive.
    expect(names).toContain("PvP - 2 Gate Expand");
    expect(names).toContain("PvT - Phoenix into Robo");
    expect(names).toContain("PvZ - Macro Transition (Unclassified)");
    expect(names).toContain("PvP - Game Too Short");
  });

  test("Protoss main universe size: matchup-prefixed Protoss catalog only", () => {
    const protossPlays: ArcadeDataset = {
      ...baseDataset,
      games: [game("PvP - 2 Gate Expand", "Protoss")],
    };
    const races = userPlayedRaces(protossPlays);
    const u = buildUniverse(protossPlays, {
      includeCatalog: true,
      catalogFilter: (def) => userEmittableCatalogEntry(def, races),
    });

    // Every surviving catalog row is matchup-prefixed and Protoss-owned.
    for (const row of u.filter((b) => b.source === "catalog")) {
      expect(row.race).toBe("Protoss");
      const def = BUILD_DEFINITIONS.find((d) => d.name === row.name);
      expect(def?.matchup).not.toBeNull();
      // Matchup label always starts with "P" for a Protoss main.
      expect(def?.matchup?.[0]).toBe("P");
    }
  });

  test("Terran main universe: drops Protoss / Zerg catalog rows", () => {
    const terranPlays: ArcadeDataset = {
      ...baseDataset,
      // The current Terran user-side detector only emits
      // "TvP - 1-1-1 One Base" + "Unclassified - Terran" until the
      // Stage-8 Terran/Zerg signature library lands, so seed the
      // dataset with the one detected myBuild label.
      games: [game("TvP - 1-1-1 One Base", "Terran")],
      builds: [
        { name: "TvP - 1-1-1 One Base", total: 4, wins: 2, losses: 2, winRate: 0.5 },
      ],
    };
    const races = userPlayedRaces(terranPlays);
    const u = buildUniverse(terranPlays, {
      includeCatalog: true,
      catalogFilter: (def) => userEmittableCatalogEntry(def, races),
    });
    const names = u.map((b) => b.name);
    // PvX and ZvX catalog rows are gone — owning race is wrong.
    expect(names).not.toContain("PvP - 2 Gate Expand");
    expect(names).not.toContain("ZvT - Game Too Short");
    // Terran-prefix race-only rows are gone too.
    expect(names).not.toContain("Terran - 1-1-1 Standard");
    // TvX matchup rows survive (only the one TvP entry exists today).
    expect(names).toContain("TvP - 1-1-1 One Base");
    expect(names).toContain("TvP - Game Too Short");
    expect(names).toContain("TvT - Game Too Short");
    expect(names).toContain("TvZ - Game Too Short");
  });

  test("multi-race dabbler: unions catalog rows across every race they've played", () => {
    const multi: ArcadeDataset = {
      ...baseDataset,
      games: [
        game("PvP - 2 Gate Expand", "Protoss"),
        game("TvP - 1-1-1 One Base", "Terran"),
      ],
    };
    const races = userPlayedRaces(multi);
    const u = buildUniverse(multi, {
      includeCatalog: true,
      catalogFilter: (def) => userEmittableCatalogEntry(def, races),
    });
    const names = u.map((b) => b.name);
    // Both Protoss-matchup and Terran-matchup catalog rows survive.
    expect(names).toContain("PvP - 2 Gate Expand");
    expect(names).toContain("TvP - 1-1-1 One Base");
    expect(names).toContain("PvP - Game Too Short");
    expect(names).toContain("TvP - Game Too Short");
    // Zerg-only catalog rows are still dropped — the user hasn't
    // touched Zerg.
    expect(names).not.toContain("ZvZ - Game Too Short");
  });

  test("own + community + custom rows are never filtered (only catalog is)", () => {
    // The catalog filter must not touch user-authored / community
    // builds — those represent the user's real play history and
    // explicit authoring intent, both of which are legitimate
    // collection entries regardless of catalog status.
    const data: ArcadeDataset = {
      ...baseDataset,
      games: [game("PvP - 2 Gate Expand", "Protoss")],
      builds: [
        // A custom-named own build that doesn't match any catalog row.
        { name: "My Special Cheese", total: 3, wins: 2, losses: 1, winRate: 0.67 },
      ],
      communityBuilds: [
        { slug: "fav", title: "Pro Player's Secret Sauce", race: "P", votes: 12 },
      ],
      customBuilds: [
        { slug: "mine", name: "Triple Stargate Experiment", race: "Protoss", vsRace: "Z" },
      ],
    };
    const races = userPlayedRaces(data);
    const u = buildUniverse(data, {
      includeCatalog: true,
      catalogFilter: (def) => userEmittableCatalogEntry(def, races),
    });
    const names = u.map((b) => b.name);
    expect(names).toContain("My Special Cheese");
    expect(names).toContain("Pro Player's Secret Sauce");
    expect(names).toContain("Triple Stargate Experiment");
  });

  test("Stock Market behaviour unchanged: full catalog when no filter is passed", () => {
    // Stock Market is the speculation surface — it intentionally
    // spans every matchup including opponent-only labels so the user
    // can bet on builds outside their own play history. Regression
    // guard: `buildUniverse(data)` (no opts) must still surface the
    // race-prefixed catalog rows the Builds-as-Cards filter strips.
    const u = buildUniverse(baseDataset);
    const names = u.map((b) => b.name);
    expect(names).toContain("Protoss - Robo Opener");
    expect(names).toContain("Terran - 1-1-1 Standard");
    expect(names).toContain("Zerg - 12 Pool");
  });
});
