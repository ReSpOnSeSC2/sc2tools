import { pct1 } from "@/lib/format";
import { outcome } from "../../ArcadeEngine";
import type { ArcadeDataset, ArcadeGame } from "../../types";
import {
  isDisplayableString,
  type FactCandidate,
} from "./twoTruthsLie.facts";

/**
 * Census-style fact families for Two Truths & a Lie. Each is a boolean-
 * existence claim drawn from the same data the Group Census quiz draws
 * on — "there exists at least one X matching profile P", where the lie
 * inverts to "every X fails profile P". The truth/lie pair is always
 * defensible: when the truth fires, the lie is literally refuted by the
 * matching example we surface in the detail string.
 *
 * Lives in a sibling file so twoTruthsLie.facts.ts (the basic-fact pool)
 * stays under the 800-line house limit.
 */

/** Minimum decided games against a group for census-style perfect /
 *  winless claims. Mirrors the Group Census quiz's `5` floor — anything
 *  smaller is just a noisy two-or-three-game streak. */
const CENSUS_MIN_GAMES = 5;

/** Same floor for "even record" claims, but raised to 10 so the
 *  truth/lie pair hinges on a real long-running rivalry rather than a
 *  fluke 1-1. */
const CENSUS_EVEN_MIN_GAMES = 10;

interface KeyedStats {
  key: string;
  displayName: string;
  wins: number;
  losses: number;
  games: number;
}

function statsByOppPulseId(data: ArcadeDataset): KeyedStats[] {
  const oppLookup = new Map(
    data.opponents.map((o) => [o.pulseId, o] as const),
  );
  const acc = new Map<string, KeyedStats>();
  for (const g of data.games) {
    if (!g.oppPulseId) continue;
    const o = outcome(g);
    if (o === "U") continue;
    let row = acc.get(g.oppPulseId);
    if (!row) {
      const opp = oppLookup.get(g.oppPulseId);
      const resolved =
        (opp?.displayName && opp.displayName.trim()) || opp?.name || "";
      row = {
        key: g.oppPulseId,
        displayName: isDisplayableString(resolved) ? resolved : g.oppPulseId,
        wins: 0,
        losses: 0,
        games: 0,
      };
      acc.set(g.oppPulseId, row);
    }
    if (o === "W") row.wins++;
    else row.losses++;
    row.games = row.wins + row.losses;
  }
  return [...acc.values()];
}

function statsByMap(games: ArcadeGame[]): KeyedStats[] {
  const acc = new Map<string, KeyedStats>();
  for (const g of games) {
    const m = typeof g.map === "string" ? g.map.trim() : "";
    if (!m) continue;
    const o = outcome(g);
    if (o === "U") continue;
    let row = acc.get(m);
    if (!row) {
      row = { key: m, displayName: m, wins: 0, losses: 0, games: 0 };
      acc.set(m, row);
    }
    if (o === "W") row.wins++;
    else row.losses++;
    row.games = row.wins + row.losses;
  }
  return [...acc.values()];
}

function statsByBuild(games: ArcadeGame[]): KeyedStats[] {
  const acc = new Map<string, KeyedStats>();
  for (const g of games) {
    const b = typeof g.myBuild === "string" ? g.myBuild.trim() : "";
    if (!b) continue;
    const o = outcome(g);
    if (o === "U") continue;
    let row = acc.get(b);
    if (!row) {
      row = { key: b, displayName: b, wins: 0, losses: 0, games: 0 };
      acc.set(b, row);
    }
    if (o === "W") row.wins++;
    else row.losses++;
    row.games = row.wins + row.losses;
  }
  return [...acc.values()];
}

/**
 * "You have at least one opponent you've played 5+ times against without
 *  ever losing." The lie inverts to "You've lost at least once to every
 *  opponent you've played 5+ times against." — which is genuinely
 *  refuted by the data when the truth fires, and vice versa.
 */
export function factPerfectOpponentExists(
  data: ArcadeDataset,
): FactCandidate | null {
  const stats = statsByOppPulseId(data).filter(
    (s) => s.games >= CENSUS_MIN_GAMES,
  );
  if (stats.length === 0) return null;
  const perfect = stats.filter((s) => s.losses === 0 && s.wins > 0);
  // Need at least one non-perfect opponent on the other side too so
  // the lie ("you've lost at least once to every…") isn't vacuously
  // true on a one-rivalry dataset.
  const nonPerfect = stats.filter((s) => s.losses > 0);
  if (perfect.length === 0 || nonPerfect.length === 0) return null;
  const sample = perfect.slice().sort((a, b) => b.games - a.games)[0];
  return {
    truthText: `You have at least one opponent you've played ${CENSUS_MIN_GAMES}+ times against without ever losing.`,
    lieText: `You've lost at least once to every opponent you've played ${CENSUS_MIN_GAMES}+ times against.`,
    detail: `${sample.displayName} · ${sample.wins}-${sample.losses} (${pct1(sample.wins / sample.games)}).`,
  };
}

/**
 * "You have at least one map you've played 5+ times on without winning
 *  a single game." Same shape as factPerfectOpponentExists, just on the
 *  losing side and grouped by map.
 */
export function factWinlessMapExists(
  data: ArcadeDataset,
): FactCandidate | null {
  const stats = statsByMap(data.games).filter(
    (s) => s.games >= CENSUS_MIN_GAMES,
  );
  if (stats.length === 0) return null;
  const winless = stats.filter((s) => s.wins === 0 && s.losses > 0);
  const nonWinless = stats.filter((s) => s.wins > 0);
  if (winless.length === 0 || nonWinless.length === 0) return null;
  const sample = winless.slice().sort((a, b) => b.games - a.games)[0];
  return {
    truthText: `You have at least one map you've played ${CENSUS_MIN_GAMES}+ times on without winning a single game.`,
    lieText: `You've won at least once on every map you've played ${CENSUS_MIN_GAMES}+ times on.`,
    detail: `${sample.displayName} · ${sample.wins}-${sample.losses} (${pct1(sample.wins / sample.games)}).`,
  };
}

/**
 * "You have at least one build with a ≥70% WR over 5+ games."
 * Inversion: every build is below 70% over its sample. Uses game-level
 * `myBuild` for time-window consistency with the Group Census quiz.
 */
export function factDominantBuildExists(
  data: ArcadeDataset,
): FactCandidate | null {
  const stats = statsByBuild(data.games).filter(
    (s) => s.games >= CENSUS_MIN_GAMES,
  );
  if (stats.length < 2) return null;
  const dominant = stats.filter((s) => s.wins / s.games >= 0.7);
  const nonDominant = stats.filter((s) => s.wins / s.games < 0.7);
  if (dominant.length === 0 || nonDominant.length === 0) return null;
  const sample = dominant.slice().sort((a, b) => b.games - a.games)[0];
  return {
    truthText: `You have at least one build with a 70%+ WR over ${CENSUS_MIN_GAMES}+ games.`,
    lieText: `Every build you've played ${CENSUS_MIN_GAMES}+ times sits below a 70% WR.`,
    detail: `${sample.displayName} · ${sample.wins}-${sample.losses} (${pct1(sample.wins / sample.games)}).`,
  };
}

/**
 * "You have at least one opponent you've played 10+ times against with
 *  an exactly even W-L record." Needs at least one non-even rivalry on
 *  the other side so the lie isn't vacuously true.
 */
export function factEvenRivalryExists(
  data: ArcadeDataset,
): FactCandidate | null {
  const stats = statsByOppPulseId(data).filter(
    (s) => s.games >= CENSUS_EVEN_MIN_GAMES,
  );
  if (stats.length < 2) return null;
  const even = stats.filter((s) => s.wins === s.losses && s.games > 0);
  const nonEven = stats.filter((s) => s.wins !== s.losses);
  if (even.length === 0 || nonEven.length === 0) return null;
  const sample = even.slice().sort((a, b) => b.games - a.games)[0];
  return {
    truthText: `You have at least one opponent you've played ${CENSUS_EVEN_MIN_GAMES}+ times against where the head-to-head is exactly even.`,
    lieText: `Every opponent you've played ${CENSUS_EVEN_MIN_GAMES}+ times against has either a winning or a losing record (no exact ties).`,
    detail: `${sample.displayName} · ${sample.wins}-${sample.losses} (${pct1(sample.wins / sample.games)}).`,
  };
}

/**
 * "More than half of your opponents are people you've only played
 *  once." The kind of "you're a ladder grinder, not a rival farmer"
 *  fact that surprises some users. Inverts directly.
 */
export function factOneAndDoneOpponents(
  data: ArcadeDataset,
): FactCandidate | null {
  const stats = statsByOppPulseId(data);
  // Need enough opponents that the majority statement is meaningful.
  if (stats.length < 8) return null;
  const singletons = stats.filter((s) => s.games === 1).length;
  const ratio = singletons / stats.length;
  // Avoid claims hovering around 50% — they're not really refuted by
  // the data. Carve out a clear margin in both directions.
  if (Math.abs(ratio - 0.5) < 0.05) return null;
  const majority = ratio > 0.5;
  return {
    truthText: majority
      ? `More than half of your opponents are people you've only played once.`
      : `Less than half of your opponents are people you've only played once.`,
    lieText: majority
      ? `Less than half of your opponents are people you've only played once.`
      : `More than half of your opponents are people you've only played once.`,
    detail: `${singletons} one-time opponents out of ${stats.length} (${pct1(ratio)}).`,
  };
}

/**
 * "You've played on at least N distinct maps in the past 90 days."
 *  N is derived from data; the lie shifts the threshold by enough that
 *  the data refutes it. The threshold is chosen so the lie is a clear
 *  inversion rather than a near-miss.
 */
export function factDistinctMapsRecent(
  data: ArcadeDataset,
): FactCandidate | null {
  const since = Date.now() - 90 * 86_400_000;
  const distinct = new Set<string>();
  for (const g of data.games) {
    const m = typeof g.map === "string" ? g.map.trim() : "";
    if (!m) continue;
    const t = new Date(g.date).getTime();
    if (!Number.isFinite(t) || t < since) continue;
    if (outcome(g) === "U") continue;
    distinct.add(m);
  }
  const count = distinct.size;
  if (count < 4) return null;
  // Pick a threshold one below `count` so the truth ("at least
  // count-1") is provable and the lie ("at least count+2") fails by a
  // clear gap.
  const truthThreshold = count - 1;
  const lieThreshold = count + 2;
  return {
    truthText: `You've played on at least ${truthThreshold} distinct maps in the past 90 days.`,
    lieText: `You've played on at least ${lieThreshold} distinct maps in the past 90 days.`,
    detail: `${count} distinct maps in the last 90d.`,
  };
}
