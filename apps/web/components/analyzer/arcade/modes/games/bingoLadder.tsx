"use client";

import { useEffect, useMemo } from "react";
import { useAuth } from "@clerk/nextjs";
import { apiCall } from "@/lib/clientApi";
import { GameStage } from "../../shells/GameStage";
import { IconFor } from "../../icons";
import { pickN, registerMode, weekKey } from "../../ArcadeEngine";
import { useArcadeState } from "../../hooks/useArcadeState";
import type {
  BingoCell,
  BingoState,
  GenerateInput,
  GenerateResult,
  Mode,
  ScoreResult,
} from "../../types";

const ID = "bingo-ladder";
registerMode(ID, "forward");

type Q = {
  weekKey: string;
  cells: BingoCell[];
};

type A = { rerolled: boolean };

const REROLL_COST = 25;

/**
 * Predicates retired in the May-2026 card overhaul. A persisted card
 * containing any of these is treated as legacy and re-generated on
 * load, so users whose card was minted under the old schema
 * automatically get the new objective mix instead of waiting up to
 * a full ISO week for the Monday rollover. Resolver-side these
 * predicates still resolve (back-compat for read paths) but the
 * generator no longer mints fresh cells for them.
 */
const LEGACY_PREDICATES = new Set([
  // Per-map objectives are gone — the user's ladder map pool is a
  // moving target, the strings render long ("Win on Whispers of
  // Gold"), and they crowded out more interesting objectives. The
  // analyzer's map-stats tab covers per-map breakdowns better than
  // a bingo cell ever could.
  "win_on_map",
]);

/**
 * Specific (predicate, paramKey) pairs retired even though the
 * predicate itself is still alive. Used to drop "Win with an Expand
 * opener" cells minted under the old card schema: the underlying
 * predicate ``win_build_contains`` is still in use for Cannon Rush /
 * Proxy / All-in / etc., but the resolver has no reliable way to
 * decide whether a given game's myBuild string represents an
 * "expand opener" — the agent's strategy classifier doesn't emit a
 * stable label for that. A persisted card carrying the cell is
 * dropped so it regenerates with a winnable objective.
 */
const LEGACY_PARAM_KEYS: ReadonlyArray<[string, string]> = [
  ["win_build_contains", "expand"],
];

async function generate(input: GenerateInput): Promise<GenerateResult<Q>> {
  const wk = weekKey(new Date(), input.tz);
  // Determine eligible races: ones the user actually played in the
  // last 30 days.
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const racesPlayed = new Set<string>();
  for (const g of input.data.games) {
    const t = new Date(g.date).getTime();
    if (Number.isFinite(t) && t < cutoff) continue;
    const r = String(g.myRace || "").charAt(0).toUpperCase();
    if (r === "P" || r === "T" || r === "Z") racesPlayed.add(r);
  }
  if (racesPlayed.size === 0) {
    return {
      ok: false,
      reason: "Need recent games to generate a card.",
    };
  }
  const cells = buildCard(input, wk, racesPlayed);
  return { ok: true, minDataMet: true, question: { weekKey: wk, cells } };
}

/**
 * A candidate objective awaiting selection. ``key`` is the de-dup
 * identifier: two candidates with the same key resolve to the same
 * tick condition (same predicate + same params) so allowing both onto
 * the card would print effectively-duplicate cells. The card builder
 * keeps the first occurrence in candidate order and silently drops
 * subsequent collisions.
 */
type Candidate = Omit<BingoCell, "id" | "ticked"> & { key: string };

/** Card builder. 25 cells; index 12 (center) is the free space. */
function buildCard(
  input: GenerateInput,
  wk: string,
  racesPlayed: Set<string>,
): BingoCell[] {
  const racePool = Array.from(racesPlayed);
  const candidates: Candidate[] = [];

  /** Append a candidate iff its key isn't already in the list. */
  const seen = new Set<string>();
  const push = (c: Candidate) => {
    if (seen.has(c.key)) return;
    seen.add(c.key);
    candidates.push(c);
  };

  // ── Race objectives ──────────────────────────────────────────
  // "Win as <race>" — only races the user actually played in the
  // last 30 days. Drawing from races they don't play would mint
  // unwinnable cells.
  for (const r of racePool) {
    push({
      key: `win_as_race:${r}`,
      predicate: "win_as_race",
      params: { race: r },
      label: `Win as ${fullRace(r)}`,
    });
  }
  // "Win vs <race>" — versus all three races (the user can't choose
  // their opponent's race, so the candidate pool stays full).
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

  // ── Generic duration objectives ──────────────────────────────
  push({
    key: "win_under_seconds:240",
    predicate: "win_under_seconds",
    params: { maxSec: 240 },
    label: "Win in under 4 minutes",
  });
  push({
    key: "win_under_seconds:360",
    predicate: "win_under_seconds",
    params: { maxSec: 360 },
    label: "Win in under 6 minutes",
  });
  push({
    key: "win_under_seconds:600",
    predicate: "win_under_seconds",
    params: { maxSec: 600 },
    label: "Win in under 10 minutes",
  });
  push({
    key: "win_over_seconds:900",
    predicate: "win_over_seconds",
    params: { minSec: 900 },
    label: "Win a 15+ minute game",
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

  // ── Macro / APM objectives ──────────────────────────────────
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
  push({
    key: "win_apm_above:150",
    predicate: "win_apm_above",
    params: { minApm: 150 },
    label: "Win with 150+ APM",
  });
  push({
    key: "win_apm_above:250",
    predicate: "win_apm_above",
    params: { minApm: 250 },
    label: "Win with 250+ APM",
  });

  // ── Build-order strategy objectives (slim row: myBuild) ─────
  // ``myBuild`` is the agent-classified strategy string like
  // "Protoss - Cannon Rush". Each candidate matches a substring
  // case-insensitively against that label — so "Cannon Rush" hits
  // both PvP and PvT cannon-rush games.
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
  // Race-specific build keywords — only winnable if the user plays
  // that race, so gate on racePool.
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

  // ── Opponent-strategy objectives ────────────────────────────
  push({
    key: "win_vs_strategy:cheese",
    predicate: "win_vs_strategy_contains",
    params: { keyword: "Cheese" },
    label: "Defend a cheese and win",
  });
  push({
    key: "win_vs_strategy:proxy",
    predicate: "win_vs_strategy_contains",
    params: { keyword: "Proxy" },
    label: "Beat a proxy build",
  });
  push({
    key: "win_vs_strategy:all-in",
    predicate: "win_vs_strategy_contains",
    params: { keyword: "All-in" },
    label: "Hold an all-in and win",
  });
  push({
    key: "win_vs_strategy:rush",
    predicate: "win_vs_strategy_contains",
    params: { keyword: "Rush" },
    label: "Survive a rush and win",
  });

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

  // ── Week-long unit-volume objectives (HEAVY: needs buildLog) ─
  // Unlike won_built_n_of_unit (which fires off a single winning
  // game), these count across every game in the week's window — wins
  // and losses both. The intent is "build N of this unit before the
  // week ends" — a forward-looking volume goal that the user can
  // chip at game-by-game even if they're losing.
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
  // "Beat a Mothership / Battlecruiser / etc." — versus everyone.
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

  const seedVariant = input.rng;
  // pickN does a Fisher-Yates shuffle and takes the first 24. The
  // candidate list above is already de-duplicated by `key`, so the
  // shuffle can't reintroduce a collision. The 24 corresponds to
  // 25 grid cells minus the center free-space.
  const picked = pickN(candidates, 24, seedVariant);
  const cells: BingoCell[] = picked.map((c, i) => ({
    id: `bingo-${wk}-${i}`,
    predicate: c.predicate,
    params: c.params,
    label: c.label,
    ticked: false,
  }));
  cells.splice(12, 0, {
    id: `bingo-${wk}-free`,
    predicate: "any_game",
    params: {},
    label: "Free space — play a game",
    ticked: false,
  });
  return cells.slice(0, 25);
}

function fullRace(letter: string): string {
  if (letter === "P") return "Protoss";
  if (letter === "T") return "Terran";
  if (letter === "Z") return "Zerg";
  return letter;
}

/**
 * Whether the saved card carries any predicate that the current
 * generator no longer mints. When true, the saved card is dropped and
 * the freshly-generated one (ctx.question.cells) replaces it on next
 * effect run. Without this, a user whose card was minted under the
 * pre-overhaul predicate set would stay stuck with map cells until
 * the next ISO-week rollover.
 */
function isLegacyCard(state: BingoState | null): boolean {
  if (!state) return false;
  if (!Array.isArray(state.cells) || state.cells.length === 0) return false;
  return state.cells.some((c) => {
    if (LEGACY_PREDICATES.has(c.predicate)) return true;
    for (const [pred, paramSub] of LEGACY_PARAM_KEYS) {
      if (c.predicate !== pred) continue;
      const p = c.params || {};
      for (const v of Object.values(p)) {
        if (typeof v === "string" && v.toLowerCase().includes(paramSub)) {
          return true;
        }
      }
    }
    return false;
  });
}

function score(q: Q): ScoreResult {
  // Engine awards XP per ticked cell on resolve, not at submit-time.
  return {
    raw: 0,
    xp: 0,
    outcome: "correct",
    note: `Bingo card · Week ${q.weekKey}`,
  };
}

export const bingoLadder: Mode<Q, A> = {
  id: ID,
  kind: "game",
  category: "forecast",
  difficulty: "medium",
  ttp: "long",
  depthTag: "forward",
  title: "Bingo: Ladder Edition",
  blurb: "5×5 of forward objectives. Resolved from your real next-7-day games.",
  generate,
  score,
  render: (ctx) => <Render ctx={ctx} />,
};

export const __test = {
  buildCard,
  isLegacyCard,
  LEGACY_PREDICATES,
  LEGACY_PARAM_KEYS,
};

function Render({
  ctx,
}: {
  ctx: Parameters<Mode<Q, A>["render"]>[0];
}) {
  const { state, update, spendMinerals } = useArcadeState();
  const { getToken, isSignedIn } = useAuth();
  const card: BingoState | null = useMemo(() => {
    if (!state.bingo) return null;
    if (state.bingo.weekKey !== ctx.question.weekKey) return null;
    // A card persisted under the pre-overhaul schema still claims the
    // current weekKey but references predicates the generator no longer
    // mints (and labels we no longer want shown). Treat as missing so
    // the seed-effect below replaces it with the fresh card.
    if (isLegacyCard(state.bingo)) return null;
    return state.bingo;
  }, [state.bingo, ctx.question.weekKey]);

  // Initialise the persisted card if missing for this week.
  //
  // Idempotency note: this effect may fire BEFORE useArcadeState has
  // hydrated from the server (state.bingo is null by default), so the
  // mutator queue in useArcadeState may replay this on top of a real
  // hydrated card. The inner check on `prev.bingo` preserves the
  // saved card (including ticked cells) instead of seeding a fresh
  // one with everything unticked — UNLESS the saved card is legacy,
  // in which case we replace it.
  useEffect(() => {
    if (card) return;
    update((prev) => {
      if (
        prev.bingo &&
        prev.bingo.weekKey === ctx.question.weekKey &&
        !isLegacyCard(prev.bingo)
      ) {
        return prev;
      }
      return {
        ...prev,
        bingo: {
          startedAt: new Date().toISOString(),
          weekKey: ctx.question.weekKey,
          rerolled: false,
          cells: ctx.question.cells,
        },
      };
    });
  }, [card, ctx.question, update]);

  // Re-resolve on every mount.
  useEffect(() => {
    if (!card || !isSignedIn) return;
    let cancelled = false;
    (async () => {
      try {
        const result = await apiCall<{ resolved: Array<{ id: string; ticked: boolean; gameId?: string }> }>(
          getToken,
          "/v1/arcade/quests/resolve",
          {
            method: "POST",
            body: JSON.stringify({ card }),
          },
        );
        if (cancelled) return;
        const ticks = new Map(result.resolved.map((r) => [r.id, r]));
        update((prev) => {
          if (!prev.bingo || prev.bingo.weekKey !== card.weekKey) return prev;
          let changed = false;
          const next = prev.bingo.cells.map((c) => {
            const r = ticks.get(c.id);
            if (r && r.ticked && !c.ticked) {
              changed = true;
              return {
                ...c,
                ticked: true,
                tickedAt: new Date().toISOString(),
                gameId: r.gameId,
              };
            }
            return c;
          });
          if (!changed) return prev;
          return { ...prev, bingo: { ...prev.bingo, cells: next } };
        });
      } catch {
        // best-effort
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [card?.weekKey, getToken, isSignedIn, update]);

  const reroll = () => {
    if (!card || card.rerolled) return;
    if (!spendMinerals(REROLL_COST)) return;
    update((prev) => {
      if (!prev.bingo) return prev;
      return {
        ...prev,
        bingo: {
          ...prev.bingo,
          startedAt: new Date().toISOString(),
          rerolled: true,
          cells: ctx.question.cells.map((c) => ({ ...c, ticked: false })),
        },
      };
    });
  };

  if (!card) {
    return (
      <GameStage
        icon={IconFor(ID)}
        title={bingoLadder.title}
        depthLabel="Forward objectives, auto-resolved"
        hud={{ hint: "Generating card…" }}
        body={<p className="text-caption text-text-muted">Generating your weekly card…</p>}
      />
    );
  }
  const ticked = card.cells.filter((c) => c.ticked).length;
  const total = card.cells.length;

  return (
    <GameStage
      icon={IconFor(ID)}
      title={bingoLadder.title}
      depthLabel="Forward 7-day quest card"
      hud={{
        score: `${ticked}/${total}`,
        hint: card.rerolled
          ? "Reroll already used this week"
          : `Reroll: ${REROLL_COST} minerals`,
      }}
      isDaily={ctx.isDaily}
      body={
        <div
          role="grid"
          aria-label="Bingo card"
          className="grid grid-cols-5 gap-1.5 text-center text-[11px]"
        >
          {card.cells.map((c, i) => (
            <div
              role="gridcell"
              key={c.id}
              aria-label={c.label}
              className={[
                "flex aspect-square min-h-[48px] flex-col items-center justify-center rounded border px-1 py-1.5",
                c.ticked
                  ? "border-success bg-success/15 text-text"
                  : "border-border bg-bg-surface text-text-muted",
                i === 12 ? "border-accent/60 bg-accent/10" : "",
              ].join(" ")}
            >
              <span className="leading-tight">{c.label}</span>
            </div>
          ))}
        </div>
      }
      primary={
        <button
          type="button"
          onClick={reroll}
          disabled={card.rerolled || (state.minerals < REROLL_COST)}
          className="inline-flex min-h-[44px] items-center gap-1.5 rounded-md border border-border bg-bg-surface px-3 text-caption font-semibold text-text hover:bg-bg-elevated disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          {card.rerolled ? "Rerolled" : `Reroll (${REROLL_COST} 💎)`}
        </button>
      }
    />
  );
}
