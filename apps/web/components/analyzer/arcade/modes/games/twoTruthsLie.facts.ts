import { pct1 } from "@/lib/format";
import { isGameTooShort, outcome } from "../../ArcadeEngine";
import type { ArcadeDataset, ArcadeGame } from "../../types";
import {
  factDistinctMapsRecent,
  factDominantBuildExists,
  factEvenRivalryExists,
  factOneAndDoneOpponents,
  factPerfectOpponentExists,
  factWinlessMapExists,
} from "./twoTruthsLie.facts.census";

/**
 * Fact-pool builders for Two Truths & a Lie. Split out of the runner
 * file so the runner stays under the 800-line house limit and so the
 * unit tests can import individual builders for targeted coverage.
 *
 * Each builder returns a `FactCandidate` (truth / lie / detail strings)
 * or null when the user's data doesn't support a meaningful claim. The
 * runner picks two truths and one lie at random from whichever subset
 * the data supports — so the more builders we ship, the more variety
 * the user sees across rounds.
 *
 * Census-style fact families live in a sibling file
 * (`twoTruthsLie.facts.census.ts`) and are pulled into the registry
 * below so the line-count cap holds without losing variety.
 */

export interface FactCandidate {
  truthText: string;
  /** A negation/inversion of the same fact that the data refutes. */
  lieText: string;
  detail: string;
}

/** A string is "displayable" when it survives templating without
 *  producing the literal "undefined" or an empty box. Treat null,
 *  empty strings, and pure-whitespace strings as missing. */
export function isDisplayableString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

/**
 * Minimum WR gap for new fact families to qualify. Filters out
 * "56.0% vs 56.9%"-style near-ties whose lie/truth pair is technically
 * correct but not interesting and looks like a glitch. The four
 * original facts predate this floor and stay relaxed so their existing
 * tests (a Reaper FE build with 75% WR vs an overall 75% WR) still
 * fire — small per-fact gates are documented inline below.
 */
export const MIN_WR_GAP = 0.04;

/**
 * Full fact pool, composed from many small per-family builders. The
 * runner picks two truths + one lie from whichever subset the user's
 * data supports.
 */
export function buildFactPool(data: ArcadeDataset): FactCandidate[] {
  const builders: Array<(d: ArcadeDataset) => FactCandidate | null> = [
    factTopBuildVsOverall,
    factShortGamesRaceSplit,
    factBestVsWorstMap,
    factLateVsEarly,
    factMatchupVsOverall,
    factTopVsSecondBuild,
    factRecentVsOlder,
    factLongVsShortGames,
    factWeekendVsWeekday,
    factTopMapVsOverall,
    factHighVsLowMmrOpponents,
    factTopRival,
    factRevengeVsMomentum,
    factOppRaceCounts,
    factBestVsWorstBuild,
    factMyRaceWrSplit,
    factAfternoonVsEvening,
    // Census-style fact families — boolean-existence claims drawn from
    // the same data the Group Census quiz draws on.
    factPerfectOpponentExists,
    factWinlessMapExists,
    factDominantBuildExists,
    factEvenRivalryExists,
    factOneAndDoneOpponents,
    factDistinctMapsRecent,
  ];
  const out: FactCandidate[] = [];
  for (const b of builders) {
    const f = b(data);
    if (f) out.push(f);
  }
  return out;
}

/* ──────────── Original four fact families ──────────── */

function factTopBuildVsOverall(data: ArcadeDataset): FactCandidate | null {
  const topBuild = data.builds
    .slice()
    .filter((b) => isDisplayableString(b.name) && !isGameTooShort(b.name))
    .sort((a, b) => b.total - a.total)[0];
  if (!topBuild || !data.summary || topBuild.total < 5) return null;
  const diff = topBuild.winRate - data.summary.winRate;
  return {
    truthText:
      diff >= 0
        ? `In your tracked history, your most-played build (“${topBuild.name}”) has a higher WR than your overall WR.`
        : `In your tracked history, your most-played build (“${topBuild.name}”) has a lower WR than your overall WR.`,
    lieText:
      diff >= 0
        ? `In your tracked history, your most-played build (“${topBuild.name}”) has a lower WR than your overall WR.`
        : `In your tracked history, your most-played build (“${topBuild.name}”) has a higher WR than your overall WR.`,
    detail: `Build WR ${pct1(topBuild.winRate)} vs overall ${pct1(data.summary.winRate)}.`,
  };
}

function factShortGamesRaceSplit(data: ArcadeDataset): FactCandidate | null {
  const shortGames = data.games.filter(
    (g) => Number(g.duration) > 0 && Number(g.duration) < 12 * 60,
  );
  if (shortGames.length < 8) return null;
  const wrByRace = wrPerOppRace(shortGames);
  const entries = Object.entries(wrByRace).filter(([, v]) => v.games >= 3);
  if (entries.length < 2) return null;
  entries.sort((a, b) => b[1].wr - a[1].wr);
  const top = entries[0][0];
  const bottom = entries[entries.length - 1][0];
  return {
    truthText: `Across your tracked games under 12 minutes, you do better vs ${fullRace(top)} than vs ${fullRace(bottom)}.`,
    lieText: `Across your tracked games under 12 minutes, you do better vs ${fullRace(bottom)} than vs ${fullRace(top)}.`,
    detail: `Short-game WR vs ${fullRace(top)} ${pct1(wrByRace[top].wr)}, vs ${fullRace(bottom)} ${pct1(wrByRace[bottom].wr)}.`,
  };
}

function factBestVsWorstMap(data: ArcadeDataset): FactCandidate | null {
  // /v1/maps occasionally returns rows with a null/empty `map` field
  // (matchmaking quirk on certain expired co-op maps) — those rows
  // make their way into the claim text as the literal string
  // "undefined" without a name filter here.
  const maps = data.maps.filter(
    (m) => isDisplayableString(m.map) && m.total >= 4,
  );
  if (maps.length < 2) return null;
  const sortedMaps = maps.slice().sort((a, b) => b.winRate - a.winRate);
  const best = sortedMaps[0];
  const worst = sortedMaps[sortedMaps.length - 1];
  if (best.map === worst.map) return null;
  return {
    truthText: `In your tracked history, you have a higher WR on ${best.map} than on ${worst.map}.`,
    lieText: `In your tracked history, you have a higher WR on ${worst.map} than on ${best.map}.`,
    detail: `${best.map} ${pct1(best.winRate)} (${best.total}g), ${worst.map} ${pct1(worst.winRate)} (${worst.total}g).`,
  };
}

function factLateVsEarly(data: ArcadeDataset): FactCandidate | null {
  const hourBuckets = bucketByHour(data.games);
  if (hourBuckets.late.total < 5 || hourBuckets.early.total < 5) return null;
  const lateWr = hourBuckets.late.wr;
  const earlyWr = hourBuckets.early.wr;
  const diff = lateWr - earlyWr;
  return {
    truthText:
      diff >= 0
        ? `Across your tracked games, your WR after 10pm is higher than your WR before noon.`
        : `Across your tracked games, your WR after 10pm is lower than your WR before noon.`,
    lieText:
      diff >= 0
        ? `Across your tracked games, your WR after 10pm is lower than your WR before noon.`
        : `Across your tracked games, your WR after 10pm is higher than your WR before noon.`,
    detail: `Late ${pct1(lateWr)} (${hourBuckets.late.total}g), early ${pct1(earlyWr)} (${hourBuckets.early.total}g).`,
  };
}

/* ──────────── Expanded fact families ──────────── */

function factMatchupVsOverall(data: ArcadeDataset): FactCandidate | null {
  if (!data.summary) return null;
  const overall = data.summary.winRate;
  const real = data.matchups.filter((m) => m.oppRace && m.total >= 6);
  if (real.length < 1) return null;
  const m = real
    .slice()
    .sort(
      (a, b) => Math.abs(b.winRate - overall) - Math.abs(a.winRate - overall),
    )[0];
  if (!m || !m.oppRace) return null;
  const diff = m.winRate - overall;
  if (Math.abs(diff) < MIN_WR_GAP) return null;
  const race = fullRace(m.oppRace);
  return {
    truthText:
      diff > 0
        ? `In your tracked history, your WR vs ${race} is higher than your overall WR.`
        : `In your tracked history, your WR vs ${race} is lower than your overall WR.`,
    lieText:
      diff > 0
        ? `In your tracked history, your WR vs ${race} is lower than your overall WR.`
        : `In your tracked history, your WR vs ${race} is higher than your overall WR.`,
    detail: `vs ${race} ${pct1(m.winRate)} (${m.total}g) vs overall ${pct1(overall)}.`,
  };
}

function factTopVsSecondBuild(data: ArcadeDataset): FactCandidate | null {
  const builds = data.builds
    .slice()
    .filter(
      (b) =>
        isDisplayableString(b.name) && !isGameTooShort(b.name) && b.total >= 4,
    )
    .sort((a, b) => b.total - a.total);
  if (builds.length < 2) return null;
  const top = builds[0];
  const second = builds[1];
  if (Math.abs(top.winRate - second.winRate) < MIN_WR_GAP) return null;
  const topBetter = top.winRate > second.winRate;
  return {
    truthText: topBetter
      ? `In your tracked history, your most-played build (“${top.name}”) wins more often than your 2nd-most (“${second.name}”).`
      : `In your tracked history, your 2nd-most-played build (“${second.name}”) wins more often than your most-played (“${top.name}”).`,
    lieText: topBetter
      ? `In your tracked history, your 2nd-most-played build (“${second.name}”) wins more often than your most-played (“${top.name}”).`
      : `In your tracked history, your most-played build (“${top.name}”) wins more often than your 2nd-most (“${second.name}”).`,
    detail: `${top.name} ${pct1(top.winRate)} (${top.total}g), ${second.name} ${pct1(second.winRate)} (${second.total}g).`,
  };
}

function factRecentVsOlder(data: ArcadeDataset): FactCandidate | null {
  const games = data.games
    .filter(
      (g) => outcome(g) !== "U" && !Number.isNaN(new Date(g.date).getTime()),
    )
    .slice()
    .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
  if (games.length < 20) return null;
  const mid = Math.floor(games.length / 2);
  const older = games.slice(0, mid);
  const recent = games.slice(mid);
  const olderWr = wrOf(older);
  const recentWr = wrOf(recent);
  if (Math.abs(olderWr - recentWr) < MIN_WR_GAP) return null;
  const recentBetter = recentWr > olderWr;
  return {
    truthText: recentBetter
      ? `Splitting your tracked games in half chronologically, your WR in the more recent half is higher than in the earlier half.`
      : `Splitting your tracked games in half chronologically, your WR in the more recent half is lower than in the earlier half.`,
    lieText: recentBetter
      ? `Splitting your tracked games in half chronologically, your WR in the more recent half is lower than in the earlier half.`
      : `Splitting your tracked games in half chronologically, your WR in the more recent half is higher than in the earlier half.`,
    detail: `Recent ${pct1(recentWr)} (${recent.length}g), earlier ${pct1(olderWr)} (${older.length}g).`,
  };
}

function factLongVsShortGames(data: ArcadeDataset): FactCandidate | null {
  const long = data.games.filter(
    (g) => Number(g.duration) > 20 * 60 && outcome(g) !== "U",
  );
  const short = data.games.filter(
    (g) =>
      Number(g.duration) > 0 &&
      Number(g.duration) < 12 * 60 &&
      outcome(g) !== "U",
  );
  if (long.length < 5 || short.length < 5) return null;
  const longWr = wrOf(long);
  const shortWr = wrOf(short);
  if (Math.abs(longWr - shortWr) < MIN_WR_GAP) return null;
  const longBetter = longWr > shortWr;
  return {
    truthText: longBetter
      ? `Across your tracked games, you win more often in games over 20 minutes than in games under 12 minutes.`
      : `Across your tracked games, you win more often in games under 12 minutes than in games over 20 minutes.`,
    lieText: longBetter
      ? `Across your tracked games, you win more often in games under 12 minutes than in games over 20 minutes.`
      : `Across your tracked games, you win more often in games over 20 minutes than in games under 12 minutes.`,
    detail: `Long ${pct1(longWr)} (${long.length}g), short ${pct1(shortWr)} (${short.length}g).`,
  };
}

function factWeekendVsWeekday(data: ArcadeDataset): FactCandidate | null {
  let weekendW = 0;
  let weekendL = 0;
  let weekdayW = 0;
  let weekdayL = 0;
  for (const g of data.games) {
    const o = outcome(g);
    if (o === "U") continue;
    const d = new Date(g.date);
    if (Number.isNaN(d.getTime())) continue;
    const dow = d.getDay();
    if (dow === 0 || dow === 6) {
      if (o === "W") weekendW++;
      else weekendL++;
    } else {
      if (o === "W") weekdayW++;
      else weekdayL++;
    }
  }
  const weTotal = weekendW + weekendL;
  const wdTotal = weekdayW + weekdayL;
  if (weTotal < 5 || wdTotal < 5) return null;
  const weWr = weekendW / weTotal;
  const wdWr = weekdayW / wdTotal;
  if (Math.abs(weWr - wdWr) < MIN_WR_GAP) return null;
  const weekendBetter = weWr > wdWr;
  return {
    truthText: weekendBetter
      ? `Across your tracked games, your weekend WR is higher than your weekday WR.`
      : `Across your tracked games, your weekend WR is lower than your weekday WR.`,
    lieText: weekendBetter
      ? `Across your tracked games, your weekend WR is lower than your weekday WR.`
      : `Across your tracked games, your weekend WR is higher than your weekday WR.`,
    detail: `Weekend ${pct1(weWr)} (${weTotal}g), weekday ${pct1(wdWr)} (${wdTotal}g).`,
  };
}

function factTopMapVsOverall(data: ArcadeDataset): FactCandidate | null {
  if (!data.summary) return null;
  const maps = data.maps.filter(
    (m) => isDisplayableString(m.map) && m.total >= 4,
  );
  if (maps.length === 0) return null;
  const top = maps.slice().sort((a, b) => b.total - a.total)[0];
  const diff = top.winRate - data.summary.winRate;
  if (Math.abs(diff) < MIN_WR_GAP) return null;
  const better = diff > 0;
  return {
    truthText: better
      ? `In your tracked history, your most-played map (${top.map}) has a higher WR than your overall WR.`
      : `In your tracked history, your most-played map (${top.map}) has a lower WR than your overall WR.`,
    lieText: better
      ? `In your tracked history, your most-played map (${top.map}) has a lower WR than your overall WR.`
      : `In your tracked history, your most-played map (${top.map}) has a higher WR than your overall WR.`,
    detail: `${top.map} ${pct1(top.winRate)} (${top.total}g) vs overall ${pct1(data.summary.winRate)}.`,
  };
}

function factHighVsLowMmrOpponents(
  data: ArcadeDataset,
): FactCandidate | null {
  let hiW = 0;
  let hiL = 0;
  let loW = 0;
  let loL = 0;
  for (const g of data.games) {
    const o = outcome(g);
    if (o === "U") continue;
    // The wire format uses 0 as a sentinel for "MMR not available
    // for this game" (early replays, unranked matches). Treat 0 the
    // same as missing so the bucket reflects real ranked comparisons.
    const me = typeof g.myMmr === "number" ? g.myMmr : 0;
    const opp = typeof g.oppMmr === "number" ? g.oppMmr : 0;
    if (me <= 0 || opp <= 0) continue;
    if (opp > me) {
      if (o === "W") hiW++;
      else hiL++;
    } else if (opp < me) {
      if (o === "W") loW++;
      else loL++;
    }
  }
  const hiT = hiW + hiL;
  const loT = loW + loL;
  if (hiT < 5 || loT < 5) return null;
  const hiWr = hiW / hiT;
  const loWr = loW / loT;
  if (Math.abs(hiWr - loWr) < MIN_WR_GAP) return null;
  const upsetBetter = hiWr > loWr;
  return {
    truthText: upsetBetter
      ? `In your tracked history, your WR vs higher-MMR opponents is higher than your WR vs lower-MMR opponents.`
      : `In your tracked history, your WR vs higher-MMR opponents is lower than your WR vs lower-MMR opponents.`,
    lieText: upsetBetter
      ? `In your tracked history, your WR vs higher-MMR opponents is lower than your WR vs lower-MMR opponents.`
      : `In your tracked history, your WR vs higher-MMR opponents is higher than your WR vs lower-MMR opponents.`,
    detail: `Above your MMR ${pct1(hiWr)} (${hiT}g), below your MMR ${pct1(loWr)} (${loT}g).`,
  };
}

function factTopRival(data: ArcadeDataset): FactCandidate | null {
  if (!data.summary) return null;
  const ops = data.opponents.filter(
    (o) => o.games >= 4 && isDisplayableString(o.displayName || o.name),
  );
  if (ops.length === 0) return null;
  const top = ops.slice().sort((a, b) => b.games - a.games)[0];
  const name = top.displayName || top.name;
  const diff = top.userWinRate - data.summary.winRate;
  if (Math.abs(diff) < MIN_WR_GAP) return null;
  const better = diff > 0;
  return {
    truthText: better
      ? `In your tracked history, your WR vs your most-faced opponent (${name}) is higher than your overall WR.`
      : `In your tracked history, your WR vs your most-faced opponent (${name}) is lower than your overall WR.`,
    lieText: better
      ? `In your tracked history, your WR vs your most-faced opponent (${name}) is lower than your overall WR.`
      : `In your tracked history, your WR vs your most-faced opponent (${name}) is higher than your overall WR.`,
    detail: `vs ${name} ${pct1(top.userWinRate)} (${top.games}g) vs overall ${pct1(data.summary.winRate)}.`,
  };
}

function factRevengeVsMomentum(data: ArcadeDataset): FactCandidate | null {
  const games = data.games
    .filter(
      (g) => outcome(g) !== "U" && !Number.isNaN(new Date(g.date).getTime()),
    )
    .slice()
    .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
  if (games.length < 12) return null;
  let afterWinW = 0;
  let afterWinL = 0;
  let afterLossW = 0;
  let afterLossL = 0;
  for (let i = 1; i < games.length; i++) {
    const prev = outcome(games[i - 1]);
    const cur = outcome(games[i]);
    if (prev === "W") {
      if (cur === "W") afterWinW++;
      else afterWinL++;
    } else if (prev === "L") {
      if (cur === "W") afterLossW++;
      else afterLossL++;
    }
  }
  const winT = afterWinW + afterWinL;
  const lossT = afterLossW + afterLossL;
  if (winT < 5 || lossT < 5) return null;
  const afterWinWr = afterWinW / winT;
  const afterLossWr = afterLossW / lossT;
  if (Math.abs(afterWinWr - afterLossWr) < MIN_WR_GAP) return null;
  const revengeBetter = afterLossWr > afterWinWr;
  return {
    truthText: revengeBetter
      ? `Across your tracked games, your WR in the game right after a loss is higher than the game right after a win.`
      : `Across your tracked games, your WR in the game right after a loss is lower than the game right after a win.`,
    lieText: revengeBetter
      ? `Across your tracked games, your WR in the game right after a loss is lower than the game right after a win.`
      : `Across your tracked games, your WR in the game right after a loss is higher than the game right after a win.`,
    detail: `After loss ${pct1(afterLossWr)} (${lossT}g), after win ${pct1(afterWinWr)} (${winT}g).`,
  };
}

function factOppRaceCounts(data: ArcadeDataset): FactCandidate | null {
  const counts: Record<"P" | "T" | "Z", number> = { P: 0, T: 0, Z: 0 };
  for (const g of data.games) {
    const r = String(g.oppRace || "").charAt(0).toUpperCase();
    if (r === "P" || r === "T" || r === "Z") counts[r as "P" | "T" | "Z"]++;
  }
  const entries = (
    Object.entries(counts) as Array<["P" | "T" | "Z", number]>
  )
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1]);
  if (entries.length < 2 || entries[0][1] < 6) return null;
  const top = entries[0];
  const bottom = entries[entries.length - 1];
  if (top[1] - bottom[1] < 4) return null;
  return {
    truthText: `In your tracked history, you've played more games vs ${fullRace(top[0])} than vs ${fullRace(bottom[0])}.`,
    lieText: `In your tracked history, you've played more games vs ${fullRace(bottom[0])} than vs ${fullRace(top[0])}.`,
    detail: `vs ${fullRace(top[0])} ${top[1]}g, vs ${fullRace(bottom[0])} ${bottom[1]}g.`,
  };
}

function factBestVsWorstBuild(data: ArcadeDataset): FactCandidate | null {
  const builds = data.builds.filter(
    (b) => isDisplayableString(b.name) && !isGameTooShort(b.name) && b.total >= 5,
  );
  if (builds.length < 2) return null;
  const sorted = builds.slice().sort((a, b) => b.winRate - a.winRate);
  const best = sorted[0];
  const worst = sorted[sorted.length - 1];
  if (best.name === worst.name) return null;
  if (best.winRate - worst.winRate < MIN_WR_GAP) return null;
  return {
    truthText: `In your tracked history, your “${best.name}” build wins more often than your “${worst.name}” build.`,
    lieText: `In your tracked history, your “${worst.name}” build wins more often than your “${best.name}” build.`,
    detail: `${best.name} ${pct1(best.winRate)} (${best.total}g), ${worst.name} ${pct1(worst.winRate)} (${worst.total}g).`,
  };
}

function factMyRaceWrSplit(data: ArcadeDataset): FactCandidate | null {
  const acc: Record<string, { w: number; t: number }> = {};
  for (const g of data.games) {
    const o = outcome(g);
    if (o === "U") continue;
    const r = String(g.myRace || "").charAt(0).toUpperCase();
    if (!(r === "P" || r === "T" || r === "Z")) continue;
    acc[r] ||= { w: 0, t: 0 };
    acc[r].t++;
    if (o === "W") acc[r].w++;
  }
  const entries = Object.entries(acc).filter(([, v]) => v.t >= 5);
  if (entries.length < 2) return null;
  entries.sort((a, b) => b[1].w / b[1].t - a[1].w / a[1].t);
  const top = entries[0];
  const bottom = entries[entries.length - 1];
  const topWr = top[1].w / top[1].t;
  const bottomWr = bottom[1].w / bottom[1].t;
  if (topWr - bottomWr < MIN_WR_GAP) return null;
  return {
    truthText: `In your tracked history, you win more often playing ${fullRace(top[0])} than playing ${fullRace(bottom[0])}.`,
    lieText: `In your tracked history, you win more often playing ${fullRace(bottom[0])} than playing ${fullRace(top[0])}.`,
    detail: `As ${fullRace(top[0])} ${pct1(topWr)} (${top[1].t}g), as ${fullRace(bottom[0])} ${pct1(bottomWr)} (${bottom[1].t}g).`,
  };
}

function factAfternoonVsEvening(data: ArcadeDataset): FactCandidate | null {
  let aW = 0;
  let aL = 0;
  let eW = 0;
  let eL = 0;
  for (const g of data.games) {
    const o = outcome(g);
    if (o === "U") continue;
    const d = new Date(g.date);
    if (Number.isNaN(d.getTime())) continue;
    const h = d.getHours();
    if (h >= 12 && h < 18) {
      if (o === "W") aW++;
      else aL++;
    } else if (h >= 18 && h < 22) {
      if (o === "W") eW++;
      else eL++;
    }
  }
  const aT = aW + aL;
  const eT = eW + eL;
  if (aT < 5 || eT < 5) return null;
  const aWr = aW / aT;
  const eWr = eW / eT;
  if (Math.abs(aWr - eWr) < MIN_WR_GAP) return null;
  const afternoonBetter = aWr > eWr;
  return {
    truthText: afternoonBetter
      ? `Across your tracked games, your afternoon WR (noon–6pm) is higher than your evening WR (6–10pm).`
      : `Across your tracked games, your afternoon WR (noon–6pm) is lower than your evening WR (6–10pm).`,
    lieText: afternoonBetter
      ? `Across your tracked games, your afternoon WR (noon–6pm) is lower than your evening WR (6–10pm).`
      : `Across your tracked games, your afternoon WR (noon–6pm) is higher than your evening WR (6–10pm).`,
    detail: `Afternoon ${pct1(aWr)} (${aT}g), evening ${pct1(eWr)} (${eT}g).`,
  };
}

/* ──────────── shared helpers ──────────── */

export function wrOf(games: ArcadeGame[]): number {
  let w = 0;
  let t = 0;
  for (const g of games) {
    const o = outcome(g);
    if (o === "U") continue;
    t++;
    if (o === "W") w++;
  }
  return t > 0 ? w / t : 0;
}

export function wrPerOppRace(
  games: ArcadeGame[],
): Record<string, { wr: number; games: number }> {
  const acc: Record<string, { wins: number; total: number }> = {};
  for (const g of games) {
    const r = String(g.oppRace || "").charAt(0).toUpperCase();
    if (!(r === "P" || r === "T" || r === "Z")) continue;
    const o = outcome(g);
    if (o === "U") continue;
    acc[r] ||= { wins: 0, total: 0 };
    acc[r].total += 1;
    if (o === "W") acc[r].wins += 1;
  }
  const out: Record<string, { wr: number; games: number }> = {};
  for (const [r, v] of Object.entries(acc)) {
    if (v.total > 0) out[r] = { wr: v.wins / v.total, games: v.total };
  }
  return out;
}

export function bucketByHour(games: ArcadeGame[]): {
  late: { wr: number; total: number };
  early: { wr: number; total: number };
} {
  let lateWins = 0;
  let lateLosses = 0;
  let earlyWins = 0;
  let earlyLosses = 0;
  for (const g of games) {
    const d = new Date(g.date);
    if (Number.isNaN(d.getTime())) continue;
    const hour = d.getHours();
    const o = outcome(g);
    if (o === "U") continue;
    if (hour >= 22 || hour < 2) {
      if (o === "W") lateWins++;
      else lateLosses++;
    } else if (hour < 12) {
      if (o === "W") earlyWins++;
      else earlyLosses++;
    }
  }
  return {
    late: {
      wr: lateWins + lateLosses > 0 ? lateWins / (lateWins + lateLosses) : 0,
      total: lateWins + lateLosses,
    },
    early: {
      wr: earlyWins + earlyLosses > 0 ? earlyWins / (earlyWins + earlyLosses) : 0,
      total: earlyWins + earlyLosses,
    },
  };
}

export function fullRace(letter: string): string {
  if (letter === "P") return "Protoss";
  if (letter === "T") return "Terran";
  if (letter === "Z") return "Zerg";
  return letter;
}
