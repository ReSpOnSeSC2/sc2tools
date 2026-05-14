// Bingo: Ladder Edition — tile candidate factory.
//
// One candidate per resolvable bingo objective the generator is
// willing to mint. The card builder in bingoLadder.tsx shuffles this
// list and takes the first 24, then splices in a center free-space.
//
// Every candidate's ``predicate`` must exist in
// apps/api/src/services/arcadePredicates.js — that's the source of
// truth for which keys the resolver can score. If you add a new
// predicate, register it there first; otherwise the cell renders
// and never ticks.
//
// Race gating: "win as <race>" / "win with a <race-specific build>" /
// "win with a <race-specific unit>" candidates are restricted to
// races the user actually played in the last 30 days (passed in via
// ``racePool``). "vs <race>" candidates stay open because the user
// can't pick their opponent's race. Without the gate, a Protoss-only
// player would get unwinnable "Win as Zerg" cells.

import type { BingoCell } from "../../types";

/**
 * A candidate objective awaiting selection. ``key`` is the de-dup
 * identifier: two candidates with the same key resolve to the same
 * tick condition (same predicate + same params) so allowing both
 * onto the card would print effectively-duplicate cells. The card
 * builder keeps the first occurrence in candidate order and silently
 * drops subsequent collisions.
 */
export type Candidate = Omit<BingoCell, "id" | "ticked"> & { key: string };

export function fullRace(letter: string): string {
  if (letter === "P") return "Protoss";
  if (letter === "T") return "Terran";
  if (letter === "Z") return "Zerg";
  return letter;
}

/**
 * Build the full deduplicated candidate list for a user.
 *
 * The output is bigger than the card (25 cells) on purpose — the
 * card builder shuffles it and takes 24, so a deep candidate pool
 * keeps the weekly card from feeling samey when the same race-pool
 * is in play week after week.
 *
 * @param racesPlayed Set of race letters ("P" | "T" | "Z") the user
 *   played in the last 30 days. Used to gate race-specific candidates.
 */
export function buildCandidates(racesPlayed: Set<string>): Candidate[] {
  const racePool = Array.from(racesPlayed);
  const candidates: Candidate[] = [];
  const seen = new Set<string>();
  const push = (c: Candidate) => {
    if (seen.has(c.key)) return;
    seen.add(c.key);
    candidates.push(c);
  };

  // ── Race objectives ──────────────────────────────────────────
  // "Win as <race>" — only races the user actually played, otherwise
  // we'd be minting unwinnable cells.
  for (const r of racePool) {
    push({
      key: `win_as_race:${r}`,
      predicate: "win_as_race",
      params: { race: r },
      label: `Win as ${fullRace(r)}`,
    });
  }
  // "Win vs <race>" — versus all three (opponent race is uncontrolled).
  for (const r of ["P", "T", "Z"] as const) {
    push({
      key: `win_vs_race:${r}`,
      predicate: "win_vs_race",
      params: { race: r },
      label: `Win vs ${fullRace(r)}`,
    });
  }

  // ── MMR objectives ───────────────────────────────────────────
  push({
    key: "win_vs_higher_mmr:100",
    predicate: "win_vs_higher_mmr",
    params: { diff: 100 },
    label: "Beat a +100 MMR opponent",
  });
  push({
    key: "win_vs_higher_mmr:200",
    predicate: "win_vs_higher_mmr",
    params: { diff: 200 },
    label: "Beat a +200 MMR opponent",
  });
  push({
    key: "win_close_mmr:25",
    predicate: "win_close_mmr",
    params: { delta: 25 },
    label: "Win a mirror-MMR game (±25)",
  });
  push({
    key: "win_close_mmr:50",
    predicate: "win_close_mmr",
    params: { delta: 50 },
    label: "Win a tight-MMR game (±50)",
  });

  // ── Streaks & volume ─────────────────────────────────────────
  push({
    key: "win_streak_n:3",
    predicate: "win_streak_n",
    params: { n: 3 },
    label: "Win 3 games in a row",
  });
  push({
    key: "win_streak_n:5",
    predicate: "win_streak_n",
    params: { n: 5 },
    label: "Win 5 games in a row",
  });
  push({
    key: "win_n_games:5",
    predicate: "win_n_games",
    params: { n: 5 },
    label: "Win 5 games this week",
  });
  push({
    key: "win_n_games:10",
    predicate: "win_n_games",
    params: { n: 10 },
    label: "Win 10 games this week",
  });
  push({
    key: "play_n_games:10",
    predicate: "play_n_games",
    params: { n: 10 },
    label: "Play 10 games this week",
  });
  push({
    key: "win_after_loss",
    predicate: "win_after_loss",
    params: {},
    label: "Bounce back: win right after a loss",
  });
  push({
    key: "revenge_win",
    predicate: "revenge_win",
    params: {},
    label: "Beat an opponent who beat you",
  });
  push({
    key: "win_in_long_session:2",
    predicate: "win_in_long_session",
    params: { minWinsBefore: 2 },
    label: "Win 3+ in one session",
  });

  // ── Duration objectives ──────────────────────────────────────
  // Lower bound is 4 minutes — anything shorter is a cheese / GG-
  // mining edge case that rarely happens twice in one week and would
  // make the cell feel arbitrary.
  push({
    key: "win_under_seconds:240",
    predicate: "win_under_seconds",
    params: { maxSec: 240 },
    label: "Win in under 4 min",
  });
  push({
    key: "win_under_seconds:360",
    predicate: "win_under_seconds",
    params: { maxSec: 360 },
    label: "Win in under 6 min",
  });
  // Bounded ranges (closed-open intervals — [min, max)). These replace
  // the opponent-strategy candidates (Survive a rush / Defend a cheese
  // / Beat a proxy / Hold an all-in) that the agent classifier
  // couldn't reliably label.
  push({
    key: "win_between_seconds:300:600",
    predicate: "win_between_seconds",
    params: { minSec: 300, maxSec: 600 },
    label: "Win a match between 5 and 10 min",
  });
  push({
    key: "win_between_seconds:600:900",
    predicate: "win_between_seconds",
    params: { minSec: 600, maxSec: 900 },
    label: "Win a match between 10 and 15 min",
  });
  push({
    key: "win_between_seconds:900:1200",
    predicate: "win_between_seconds",
    params: { minSec: 900, maxSec: 1200 },
    label: "Win a match between 15 and 20 min",
  });
  push({
    key: "win_over_seconds:1200",
    predicate: "win_over_seconds",
    params: { minSec: 1200 },
    label: "Win a 20+ minute game",
  });
  push({
    key: "win_over_seconds:1500",
    predicate: "win_over_seconds",
    params: { minSec: 1500 },
    label: "Win a 25+ minute game",
  });
  push({
    key: "win_over_seconds:1800",
    predicate: "win_over_seconds",
    params: { minSec: 1800 },
    label: "Win a 30+ minute game",
  });

  // ── Race + time combos ──────────────────────────────────────
  // "Quick win as <race>" and "Macro win as <race>" — only for races
  // the user actually plays, so the cell is winnable.
  for (const r of racePool) {
    push({
      key: `win_as_race_under:${r}:480`,
      predicate: "win_as_race_under",
      params: { race: r, maxSec: 480 },
      label: `Win as ${fullRace(r)} in under 8 min`,
    });
    push({
      key: `win_as_race_over:${r}:1200`,
      predicate: "win_as_race_over",
      params: { race: r, minSec: 1200 },
      label: `Win as ${fullRace(r)} in 20+ min`,
    });
  }
  // "Versus <race> quickly / slowly" — versus pool is all three.
  for (const r of ["P", "T", "Z"] as const) {
    push({
      key: `win_vs_race_under:${r}:480`,
      predicate: "win_vs_race_under",
      params: { race: r, maxSec: 480 },
      label: `Win vs ${fullRace(r)} in under 8 min`,
    });
    push({
      key: `win_vs_race_over:${r}:1200`,
      predicate: "win_vs_race_over",
      params: { race: r, minSec: 1200 },
      label: `Win vs ${fullRace(r)} in 20+ min`,
    });
  }

  // ── Macro objectives ────────────────────────────────────────
  // APM cells were retired in the May-2026 follow-up: per-game APM
  // ingestion is unreliable (some replays ship a value that's an
  // average across the player+opponent and others ship a per-player
  // figure, so a 150-APM cell ticked or didn't depending on which
  // path produced the row). Keeping macro-only cells avoids that
  // ambiguity — macroScore is a single number the agent computes
  // deterministically from supply / build / inject timings.
  push({
    key: "macro_above:70",
    predicate: "macro_above",
    params: { minScore: 70 },
    label: "Hit macro score 70+",
  });
  push({
    key: "macro_above:80",
    predicate: "macro_above",
    params: { minScore: 80 },
    label: "Hit macro score 80+",
  });
  push({
    key: "macro_above:90",
    predicate: "macro_above",
    params: { minScore: 90 },
    label: "Hit macro score 90+",
  });
  push({
    key: "win_macro_below:40",
    predicate: "win_macro_below",
    params: { maxScore: 40 },
    label: "Win with macro score under 40",
  });

  // ── Build-order strategy objectives (myBuild substring) ─────
  // ``myBuild`` is the agent-classified strategy label like
  // "Protoss - Cannon Rush". Each candidate matches a substring
  // case-insensitively. Unlike the retired opponent-strategy
  // candidates, classifying YOUR OWN build is solid — the agent
  // has the full replay and emits stable labels.
  push({
    key: "win_build:cannon-rush",
    predicate: "win_build_contains",
    params: { keyword: "Cannon Rush" },
    label: "Win with a Cannon Rush",
  });
  push({
    key: "win_build:proxy",
    predicate: "win_build_contains",
    params: { keyword: "Proxy" },
    label: "Win with a Proxy build",
  });
  push({
    key: "win_build:all-in",
    predicate: "win_build_contains",
    params: { keyword: "All-in" },
    label: "Win with an All-in",
  });
  push({
    key: "win_build:macro",
    predicate: "win_build_contains",
    params: { keyword: "Macro" },
    label: "Win with a Macro build",
  });
  // Race-specific build keywords — gate on racePool.
  if (racePool.includes("P")) {
    push({
      key: "win_build:dt-rush",
      predicate: "win_build_contains",
      params: { keyword: "DT Rush" },
      label: "Win with a DT Rush",
    });
    push({
      key: "win_build:blink",
      predicate: "win_build_contains",
      params: { keyword: "Blink" },
      label: "Win with a Blink build",
    });
  }
  if (racePool.includes("Z")) {
    push({
      key: "win_build:roach",
      predicate: "win_build_contains",
      params: { keyword: "Roach" },
      label: "Win with a Roach build",
    });
    push({
      key: "win_build:ling-bane",
      predicate: "win_build_contains",
      params: { keyword: "Ling Bane" },
      label: "Win with a Ling/Bane comp",
    });
  }
  if (racePool.includes("T")) {
    push({
      key: "win_build:reaper",
      predicate: "win_build_contains",
      params: { keyword: "Reaper" },
      label: "Win with a Reaper opener",
    });
    push({
      key: "win_build:bio",
      predicate: "win_build_contains",
      params: { keyword: "Bio" },
      label: "Win with a Bio army",
    });
  }

  // ── Unit-built objectives (HEAVY: needs buildLog) ───────────
  // The resolver lazily loads game_details for heavy predicates so
  // these stay live even when most cells are slim-row-only. Keep
  // the unit names broad enough to match across SC2 nameId casings
  // — the resolver does a case-insensitive substring match against
  // each "[mm:ss] <unit>" line.
  if (racePool.includes("P")) {
    push({
      key: "won_with_unit:Mothership",
      predicate: "won_with_unit",
      params: { unit: "Mothership" },
      label: "Win a game with a Mothership",
    });
    push({
      key: "won_with_unit:Carrier",
      predicate: "won_with_unit",
      params: { unit: "Carrier" },
      label: "Win a game with Carriers",
    });
    push({
      key: "won_with_unit:Tempest",
      predicate: "won_with_unit",
      params: { unit: "Tempest" },
      label: "Win a game with Tempests",
    });
    push({
      key: "won_built_n_of_unit:Zealot:10",
      predicate: "won_built_n_of_unit",
      params: { unit: "Zealot", count: 10 },
      label: "Build 10+ Zealots in a win",
    });
  }
  if (racePool.includes("T")) {
    push({
      key: "won_with_unit:Battlecruiser",
      predicate: "won_with_unit",
      params: { unit: "Battlecruiser" },
      label: "Win a game with Battlecruisers",
    });
    push({
      key: "won_with_unit:Ghost",
      predicate: "won_with_unit",
      params: { unit: "Ghost" },
      label: "Win a game with Ghosts",
    });
    push({
      key: "won_with_unit:Thor",
      predicate: "won_with_unit",
      params: { unit: "Thor" },
      label: "Win a game with Thors",
    });
    push({
      key: "won_built_n_of_unit:Marine:20",
      predicate: "won_built_n_of_unit",
      params: { unit: "Marine", count: 20 },
      label: "Build 20+ Marines in a win",
    });
  }
  if (racePool.includes("Z")) {
    push({
      key: "won_with_unit:Ultralisk",
      predicate: "won_with_unit",
      params: { unit: "Ultralisk" },
      label: "Win a game with Ultralisks",
    });
    push({
      key: "won_with_unit:BroodLord",
      predicate: "won_with_unit",
      params: { unit: "Brood Lord" },
      label: "Win a game with Brood Lords",
    });
    push({
      key: "won_with_unit:Lurker",
      predicate: "won_with_unit",
      params: { unit: "Lurker" },
      label: "Win a game with Lurkers",
    });
    push({
      key: "won_built_n_of_unit:Zergling:30",
      predicate: "won_built_n_of_unit",
      params: { unit: "Zergling", count: 30 },
      label: "Build 30+ Zerglings in a win",
    });
  }

  // ── Week-long unit-volume objectives (HEAVY) ────────────────
  // Unlike won_built_n_of_unit (single winning game), these count
  // across every game in the week's window — wins and losses both.
  // Forward-looking volume goal the user can chip at game-by-game
  // even when losing.
  if (racePool.includes("P")) {
    push({
      key: "built_n_of_unit_week:Zealot:40",
      predicate: "built_n_of_unit_week",
      params: { unit: "Zealot", count: 40 },
      label: "Build 40+ Zealots this week",
    });
    push({
      key: "built_n_of_unit_week:Stalker:50",
      predicate: "built_n_of_unit_week",
      params: { unit: "Stalker", count: 50 },
      label: "Build 50+ Stalkers this week",
    });
    push({
      key: "built_n_of_unit_week:Immortal:15",
      predicate: "built_n_of_unit_week",
      params: { unit: "Immortal", count: 15 },
      label: "Build 15+ Immortals this week",
    });
  }
  if (racePool.includes("T")) {
    push({
      key: "built_n_of_unit_week:Marine:100",
      predicate: "built_n_of_unit_week",
      params: { unit: "Marine", count: 100 },
      label: "Build 100+ Marines this week",
    });
    push({
      key: "built_n_of_unit_week:Marauder:30",
      predicate: "built_n_of_unit_week",
      params: { unit: "Marauder", count: 30 },
      label: "Build 30+ Marauders this week",
    });
    push({
      key: "built_n_of_unit_week:SiegeTank:15",
      predicate: "built_n_of_unit_week",
      params: { unit: "Siege Tank", count: 15 },
      label: "Build 15+ Siege Tanks this week",
    });
  }
  if (racePool.includes("Z")) {
    push({
      key: "built_n_of_unit_week:Zergling:150",
      predicate: "built_n_of_unit_week",
      params: { unit: "Zergling", count: 150 },
      label: "Build 150+ Zerglings this week",
    });
    push({
      key: "built_n_of_unit_week:Roach:40",
      predicate: "built_n_of_unit_week",
      params: { unit: "Roach", count: 40 },
      label: "Build 40+ Roaches this week",
    });
    push({
      key: "built_n_of_unit_week:Hydralisk:30",
      predicate: "built_n_of_unit_week",
      params: { unit: "Hydralisk", count: 30 },
      label: "Build 30+ Hydralisks this week",
    });
  }

  // ── Opponent unit-seen objectives ───────────────────────────
  push({
    key: "won_built_opp_unit_seen:Mothership",
    predicate: "won_built_opp_unit_seen",
    params: { unit: "Mothership" },
    label: "Beat a player who built a Mothership",
  });
  push({
    key: "won_built_opp_unit_seen:Battlecruiser",
    predicate: "won_built_opp_unit_seen",
    params: { unit: "Battlecruiser" },
    label: "Beat a player who built a Battlecruiser",
  });
  push({
    key: "won_built_opp_unit_seen:BroodLord",
    predicate: "won_built_opp_unit_seen",
    params: { unit: "Brood Lord" },
    label: "Beat a player who built Brood Lords",
  });

  return candidates;
}
