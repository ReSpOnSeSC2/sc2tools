import { describe, expect, test } from "vitest";
import {
  attackForBuild,
  buildUniverse,
  defenseFor,
  isFoil,
  isUnclassifiedSentinel,
  rolling14DayWr,
} from "../sessions";
import type { ArcadeDataset } from "../types";

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

describe("Stock Market: build universe + price math", () => {
  test("universe is the union of own + ALL community + all authored custom builds", () => {
    const dataset: ArcadeDataset = {
      ...baseDataset,
      builds: [{ name: "Reaper FE", total: 12, wins: 8, losses: 4, winRate: 0.67 }],
      communityBuilds: [
        { slug: "reaper-fe", title: "Reaper FE", race: "T", votes: 12 },
        // Cross-race community build the user has never played — used
        // to be filtered out, now surfaces (untradeable) so Stock
        // Market spans every matchup, not just the user's own race.
        { slug: "stargate-opener", title: "Stargate Opener", race: "P", votes: 9 },
        { slug: "zergling-rush", title: "Zergling Rush", race: "Z", votes: 4 },
      ],
      customBuilds: [
        { slug: "my-special", name: "Reaper FE", race: "T", vsRace: "Z" },
        { slug: "wip-build", name: "Triple Stargate Experiment", race: "P", vsRace: "X" },
      ],
    };
    const u = buildUniverse(dataset);
    const names = u.map((b) => b.name).sort();
    expect(names).toContain("Reaper FE");
    expect(names).toContain("Triple Stargate Experiment");
    expect(names).toContain("Stargate Opener");
    expect(names).toContain("Zergling Rush");
    expect(new Set(names).size).toBe(names.length);
    // Cross-race community builds enter as `community` source with
    // zero plays — the UI surfaces them as "no price yet" and disables
    // the allocation input until the user actually plays them.
    const stargate = u.find((b) => b.name === "Stargate Opener")!;
    expect(stargate.source).toBe("community");
    expect(stargate.totalPlays).toBe(0);
  });

  test("drops 'Unclassified - <Race>' placeholder builds from every source", () => {
    // Python detectors/user.py emits "Unclassified - <Race>" as a
    // sentinel when no signature in the registry matches the replay.
    // These are not real builds — they're a "couldn't classify" stub
    // and must NOT appear in the Stock Market.
    const dataset: ArcadeDataset = {
      ...baseDataset,
      builds: [
        { name: "Unclassified - Protoss", total: 30, wins: 20, losses: 10, winRate: 0.67 },
        { name: "Unclassified - BW Protoss", total: 5, wins: 3, losses: 2, winRate: 0.6 },
        { name: "Unclassified - Terran", total: 4, wins: 1, losses: 3, winRate: 0.25 },
        { name: "Unclassified - Zerg", total: 3, wins: 0, losses: 3, winRate: 0 },
        // Partial classifications are kept — they carry matchup info.
        { name: "PvT - Macro Transition (Unclassified)", total: 8, wins: 5, losses: 3, winRate: 0.625 },
      ],
      communityBuilds: [
        { slug: "junk", title: "Unclassified - Protoss", race: "P", votes: 1 },
        { slug: "real", title: "Phoenix Opener", race: "P", votes: 5 },
      ],
      customBuilds: [
        { slug: "stub", name: "Unclassified - Zerg", race: "Z", vsRace: "X" },
        { slug: "real-custom", name: "My Special Cheese", race: "T", vsRace: "P" },
      ],
    };
    const u = buildUniverse(dataset);
    const names = u.map((b) => b.name);
    expect(names).not.toContain("Unclassified - Protoss");
    expect(names).not.toContain("Unclassified - BW Protoss");
    expect(names).not.toContain("Unclassified - Terran");
    expect(names).not.toContain("Unclassified - Zerg");
    // Partial classifications survive the filter.
    expect(names).toContain("PvT - Macro Transition (Unclassified)");
    expect(names).toContain("Phoenix Opener");
    expect(names).toContain("My Special Cheese");
  });

  test("BUILD_DEFINITIONS catalog seeds the universe with every analyzer-detectable strategy", () => {
    // The bundled catalog at apps/web/lib/build-definitions.ts has 101
    // entries spanning every race and matchup. A Protoss main with no
    // Z/T plays and no Z/T community/custom builds must still see Z/T
    // rows in the Stock Market — that's the whole point of folding the
    // catalog in. We don't pin the exact set here (the catalog evolves
    // with the analyzer rule set); instead we assert representation
    // from each race.
    const u = buildUniverse(baseDataset);
    expect(u.length).toBeGreaterThan(50);
    const hasProtoss = u.some((b) => b.race === "Protoss" && b.source === "catalog");
    const hasTerran = u.some((b) => b.race === "Terran" && b.source === "catalog");
    const hasZerg = u.some((b) => b.race === "Zerg" && b.source === "catalog");
    expect(hasProtoss).toBe(true);
    expect(hasTerran).toBe(true);
    expect(hasZerg).toBe(true);
  });

  test("catalog source defers to own / community / custom when names collide", () => {
    // If the user has already played "Protoss - 4 Gate Rush" (a real
    // catalog entry), the universe row must carry their actual win
    // rate and source=own — not get overwritten by the catalog's
    // zero-play stub.
    const dataset: ArcadeDataset = {
      ...baseDataset,
      builds: [
        { name: "Protoss - 4 Gate Rush", total: 25, wins: 18, losses: 7, winRate: 0.72 },
      ],
    };
    const u = buildUniverse(dataset);
    const row = u.find((b) => b.name === "Protoss - 4 Gate Rush");
    expect(row).toBeDefined();
    expect(row!.source).toBe("own");
    expect(row!.totalPlays).toBe(25);
    expect(row!.winRate).toBeCloseTo(0.72, 5);
  });

  test("own builds inherit race from the catalog when /v1/builds omits it", () => {
    // /v1/builds aggregates over myBuild and never projects a race
    // field (apps/api/src/services/builds.js). For builds whose name
    // matches a catalog entry, the universe row must backfill race from
    // the catalog so the Builds-as-Cards binder renders the correct
    // race icon instead of the random/dice fallback.
    const dataset: ArcadeDataset = {
      ...baseDataset,
      builds: [
        { name: "PvP - 1 Gate Expand", total: 12, wins: 7, losses: 5, winRate: 0.58 },
        { name: "PvZ - Carrier Rush", total: 4, wins: 3, losses: 1, winRate: 0.75 },
        { name: "PvT - Phoenix into Robo", total: 9, wins: 6, losses: 3, winRate: 0.67 },
      ],
    };
    const u = buildUniverse(dataset);
    expect(u.find((b) => b.name === "PvP - 1 Gate Expand")?.race).toBe("Protoss");
    expect(u.find((b) => b.name === "PvZ - Carrier Rush")?.race).toBe("Protoss");
    expect(u.find((b) => b.name === "PvT - Phoenix into Robo")?.race).toBe("Protoss");
  });

  test("own builds infer race from matchup prefix when not in the catalog", () => {
    // Custom / detector names that aren't in BUILD_DEFINITIONS (e.g.
    // partial classifications, user-renamed entries) still expose a
    // matchup prefix. Inferring from the prefix is the last line of
    // defense before falling through to Random.
    const dataset: ArcadeDataset = {
      ...baseDataset,
      builds: [
        { name: "PvT - Macro Transition (Unclassified)", total: 8, wins: 5, losses: 3, winRate: 0.625 },
        { name: "TvZ - Mech Nonsense", total: 3, wins: 1, losses: 2, winRate: 0.33 },
        { name: "ZvP - Roach Ravager All-in", total: 6, wins: 4, losses: 2, winRate: 0.67 },
      ],
    };
    const u = buildUniverse(dataset);
    expect(u.find((b) => b.name === "PvT - Macro Transition (Unclassified)")?.race).toBe("Protoss");
    expect(u.find((b) => b.name === "TvZ - Mech Nonsense")?.race).toBe("Terran");
    expect(u.find((b) => b.name === "ZvP - Roach Ravager All-in")?.race).toBe("Zerg");
  });

  test("supplied race is never overridden by catalog or name inference", () => {
    // Community + custom rows that DO carry a race field must keep it
    // — `resolveRace` is a fallback, not an override. Verifies we
    // don't, e.g., silently rewrite a user-authored cross-race custom
    // build.
    const dataset: ArcadeDataset = {
      ...baseDataset,
      communityBuilds: [
        // Force a deliberate mismatch: name suggests Zerg, race says Terran.
        // `resolveRace` must trust the supplied race.
        { slug: "weird", title: "ZvP - Definitely Terran Somehow", race: "T", votes: 1 },
      ],
      customBuilds: [
        { slug: "mine", name: "PvP - 1 Gate Expand", race: "Z", vsRace: "P" },
      ],
    };
    const u = buildUniverse(dataset);
    expect(u.find((b) => b.name === "ZvP - Definitely Terran Somehow")?.race).toBe("T");
    expect(u.find((b) => b.name === "PvP - 1 Gate Expand")?.race).toBe("Z");
  });

  test("isUnclassifiedSentinel matches the Python emitter format", () => {
    expect(isUnclassifiedSentinel("Unclassified - Protoss")).toBe(true);
    expect(isUnclassifiedSentinel("Unclassified - BW Protoss")).toBe(true);
    expect(isUnclassifiedSentinel("Unclassified - Terran")).toBe(true);
    expect(isUnclassifiedSentinel("Unclassified - Zerg")).toBe(true);
    // Hyphen-spacing tolerance: detector emits "X - Y" but past versions
    // may have used "X-Y".
    expect(isUnclassifiedSentinel("Unclassified-Protoss")).toBe(true);
    // Partial-classification suffix is NOT a sentinel.
    expect(isUnclassifiedSentinel("PvT - Macro Transition (Unclassified)")).toBe(false);
    expect(isUnclassifiedSentinel("Reaper FE")).toBe(false);
    expect(isUnclassifiedSentinel("")).toBe(false);
  });

  test("brand-new authored custom build enters universe with totalPlays=0", () => {
    const dataset: ArcadeDataset = {
      ...baseDataset,
      customBuilds: [
        { slug: "fresh", name: "Brand New Build", race: "Z", vsRace: "X" },
      ],
    };
    const u = buildUniverse(dataset);
    // The universe now also contains BUILD_DEFINITIONS catalog entries
    // (~101 rows) — assert the custom build is present rather than
    // pinning total length to 1.
    const row = u.find((b) => b.name === "Brand New Build");
    expect(row).toBeDefined();
    expect(row!.totalPlays).toBe(0);
    expect(row!.source).toBe("custom");
  });

  test("rolling14DayWr returns null below 3 plays in window", () => {
    const now = new Date("2026-05-10T00:00:00Z");
    const dataset: ArcadeDataset = {
      ...baseDataset,
      games: [
        { gameId: "g1", date: "2026-05-09T00:00:00Z", result: "Win", myBuild: "X" },
        { gameId: "g2", date: "2026-05-09T00:00:00Z", result: "Win", myBuild: "X" },
      ],
    };
    expect(rolling14DayWr("X", dataset, now)).toBeNull();
  });

  test("rolling14DayWr ignores games outside the window", () => {
    const now = new Date("2026-05-10T00:00:00Z");
    const dataset: ArcadeDataset = {
      ...baseDataset,
      games: [
        { gameId: "1", date: "2026-04-01T00:00:00Z", result: "Win", myBuild: "X" }, // outside window
        { gameId: "2", date: "2026-05-09T00:00:00Z", result: "Win", myBuild: "X" },
        { gameId: "3", date: "2026-05-09T00:00:00Z", result: "Win", myBuild: "X" },
        { gameId: "4", date: "2026-05-09T00:00:00Z", result: "Loss", myBuild: "X" },
      ],
    };
    expect(rolling14DayWr("X", dataset, now)).toBeCloseTo(2 / 3, 5);
  });

  test("matchup-agnostic build priced from games across multiple opponent races (vsRace='X')", () => {
    // The custom build "Universal" was authored with vsRace="X", meaning
    // it should be priced from wins/losses across any opponent race.
    const now = new Date("2026-05-10T00:00:00Z");
    const dataset: ArcadeDataset = {
      ...baseDataset,
      customBuilds: [
        { slug: "uni", name: "Universal", race: "Z", vsRace: "X" },
      ],
      games: [
        { gameId: "1", date: "2026-05-09T00:00:00Z", result: "Win", myBuild: "Universal", oppRace: "T" },
        { gameId: "2", date: "2026-05-09T00:00:00Z", result: "Win", myBuild: "Universal", oppRace: "P" },
        { gameId: "3", date: "2026-05-09T00:00:00Z", result: "Win", myBuild: "Universal", oppRace: "Z" },
        { gameId: "4", date: "2026-05-09T00:00:00Z", result: "Loss", myBuild: "Universal", oppRace: "T" },
      ],
    };
    // 3 wins + 1 loss = 0.75 — naïvely counts all races.
    expect(rolling14DayWr("Universal", dataset, now)).toBeCloseTo(0.75, 5);
    const u = buildUniverse(dataset);
    // Universe contains the authored custom build (zero plays from
    // /v1/builds, but it must still surface).
    const uni = u.find((b) => b.name === "Universal");
    expect(uni).toBeDefined();
    expect(uni!.source).toBe("custom");
  });

  test("attack/defense/foil derivations are within bounds and sensible", () => {
    const dataset: ArcadeDataset = {
      ...baseDataset,
      builds: [{ name: "Y", total: 20, wins: 14, losses: 6, winRate: 0.7 }],
      games: [
        { gameId: "1", date: "2026-05-09T00:00:00Z", result: "Win", myBuild: "Y", duration: 600 },
        { gameId: "2", date: "2026-05-09T00:00:00Z", result: "Win", myBuild: "Y", duration: 720 },
      ],
    };
    expect(attackForBuild(dataset.builds[0])).toBe(70);
    expect(defenseFor("Y", dataset)).toBe(11); // round((660)/60) = 11
    expect(isFoil("Y", dataset)).toBe(true);
  });
});

/**
 * Play-volume volatility multiplier. Mirrors `volatility()` in
 * stockMarket.tsx — keep these in sync. Modelled on the standard
 * error of a proportion (~ 1/√n) so few-play builds amplify P&L
 * (high sample noise = wide variance) and heavily-played builds
 * damp it. Anchored at 30 plays = 1.0×, bounded 0.75×..2.0×.
 */
const VOL_BASELINE_PLAYS = 30;
const VOL_MIN = 0.75;
const VOL_MAX = 2.0;
export function volatility(plays: number): number {
  const n = Math.max(1, plays);
  const raw = Math.sqrt(VOL_BASELINE_PLAYS / n);
  return Math.max(VOL_MIN, Math.min(VOL_MAX, raw));
}

/**
 * Pure portfolio P&L helper — replicates the reveal math the surface
 * uses. P&L per pick = weight × % return on entry price × volatility
 * multiplier on entry plays. Two independent levers: low-price builds
 * amplify % return per Δprice, low-play builds amplify the variance
 * multiplier on top of that. `entryPlays` is optional for back-compat
 * with portfolios locked before the volatility model — those default
 * to vol = 1.0 (neutral). Result is in percentage points.
 */
export function portfolioPnl(
  picks: Array<{ slug: string; alloc: number; entryPrice: number; entryPlays?: number }>,
  pricesNow: Record<string, number>,
): number {
  let pnl = 0;
  for (const p of picks) {
    const cur = pricesNow[p.slug];
    if (typeof cur !== "number") continue;
    if (p.entryPrice <= 0) continue;
    const ret = (cur - p.entryPrice) / p.entryPrice;
    const vol = typeof p.entryPlays === "number" ? volatility(p.entryPlays) : 1.0;
    pnl += p.alloc * ret * vol;
  }
  return pnl;
}

describe("Stock Market portfolio P&L", () => {
  test("weights % return on entry price, not raw Δprice", () => {
    // Two picks with the same raw Δprice (+5) but different entry
    // prices yield different P&L: the low-price entry has a higher
    // % return, so it contributes more.
    const pnl = portfolioPnl(
      [
        { slug: "cheap", alloc: 50, entryPrice: 30 },
        { slug: "premium", alloc: 50, entryPrice: 90 },
      ],
      { cheap: 35, premium: 95 },
    );
    // 50 × (5/30) + 50 × (5/90) ≈ 8.333 + 2.778 ≈ 11.111
    expect(pnl).toBeCloseTo(11.111, 3);
  });
  test("offsetting returns net out", () => {
    const pnl = portfolioPnl(
      [
        { slug: "A", alloc: 50, entryPrice: 50 },
        { slug: "B", alloc: 50, entryPrice: 50 },
      ],
      { A: 60, B: 40 },
    );
    // 50 × (10/50) + 50 × (-10/50) = 10 + (-10) = 0
    expect(pnl).toBe(0);
  });
  test("missing prices are skipped, not zeroed", () => {
    expect(
      portfolioPnl([{ slug: "A", alloc: 100, entryPrice: 50 }], {}),
    ).toBe(0);
  });
  test("zero or invalid entry price is skipped (avoid divide-by-zero)", () => {
    expect(
      portfolioPnl(
        [{ slug: "A", alloc: 100, entryPrice: 0 }],
        { A: 50 },
      ),
    ).toBe(0);
  });
  test("missing entryPlays defaults to neutral 1.0× volatility (back-compat)", () => {
    // Portfolios locked before the volatility model existed have no
    // entryPlays. They must still compute P&L the same as the prior
    // % return formula — no surprise multiplier on legacy data.
    const pnl = portfolioPnl(
      [{ slug: "A", alloc: 100, entryPrice: 50 }],
      { A: 60 },
    );
    expect(pnl).toBeCloseTo(20, 5); // 100 × (10/50) × 1.0 = 20
  });
});

describe("Stock Market volatility curve", () => {
  test("anchored at baseline plays = 1.0× neutral", () => {
    expect(volatility(30)).toBeCloseTo(1.0, 5);
  });
  test("clamps low play counts to the 2.0× ceiling", () => {
    // Raw √(30/1) ≈ 5.48 — clamped to MAX so a single-play build
    // can't trivially dominate optimal strategy.
    expect(volatility(0)).toBe(2.0);
    expect(volatility(1)).toBe(2.0);
    expect(volatility(5)).toBe(2.0);
    expect(volatility(7)).toBe(2.0);
  });
  test("decays smoothly through the mid-range", () => {
    expect(volatility(10)).toBeCloseTo(Math.sqrt(3), 3);
    expect(volatility(20)).toBeCloseTo(Math.sqrt(1.5), 3);
  });
  test("clamps high play counts to the 0.75× floor", () => {
    // Raw √(30/100) ≈ 0.55 — clamped to MIN so heavily-played
    // veterans still carry some volatility (vol > 0).
    expect(volatility(100)).toBe(0.75);
    expect(volatility(1000)).toBe(0.75);
  });

  test("low-play + low-price stacks both multipliers vs high-play + high-price", () => {
    // Same alloc, same Δprice. The "underdog" (cheap, brand-new) gets
    // amplified by both the % return (low denominator) and the
    // volatility multiplier (high variance). The "veteran blue chip"
    // (expensive, heavily played) gets dampened by both.
    const underdog = portfolioPnl(
      [{ slug: "X", alloc: 50, entryPrice: 30, entryPlays: 2 }],
      { X: 35 }, // +5 raw
    );
    const veteran = portfolioPnl(
      [{ slug: "X", alloc: 50, entryPrice: 90, entryPlays: 200 }],
      { X: 95 }, // +5 raw
    );
    // underdog: 50 × (5/30) × 2.0 ≈ 16.67
    // veteran:  50 × (5/90) × 0.75 ≈ 2.08
    expect(underdog).toBeCloseTo(16.667, 2);
    expect(veteran).toBeCloseTo(2.083, 2);
    expect(underdog).toBeGreaterThan(veteran * 5);
  });
});
