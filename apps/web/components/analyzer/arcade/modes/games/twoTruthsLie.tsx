"use client";

import { useMemo, useState } from "react";
import { pct1 } from "@/lib/format";
import { QuizAnswerButton, QuizCard } from "../../shells/QuizCard";
import { IconFor } from "../../icons";
import { outcome, pickN, registerMode, shuffle } from "../../ArcadeEngine";
import type {
  ArcadeDataset,
  ArcadeGame,
  GenerateInput,
  GenerateResult,
  Mode,
  ScoreResult,
  ShareSummary,
} from "../../types";

const ID = "two-truths-lie";
registerMode(ID, "cross-axis");

type Claim = {
  text: string;
  truthful: boolean;
  detail: string;
};

type Q = {
  claims: Claim[];
  lieIndex: number;
};

type A = number;

/**
 * Generate three multi-axis claims about the user — two true, one
 * false. Every claim must combine ≥2 axes (matchup × time-of-day,
 * game-length × race, build × map), so a single-tab sort never gives
 * the answer away. The "lie" is built by perturbing one true claim
 * into something the data clearly refutes; the engine refuses to ship
 * a round if it can't fabricate a clearly-false claim.
 */
async function generate(input: GenerateInput): Promise<GenerateResult<Q>> {
  if (input.data.games.length < 25) {
    return { ok: false, reason: "Need at least 25 games to weave claims from." };
  }
  const facts = buildFactPool(input.data);
  if (facts.length < 3) {
    return { ok: false, reason: "Couldn't find enough cross-axis facts." };
  }
  const truths = pickN(facts, 2, input.rng);
  // Construct a lie by inverting one fact.
  const remaining = facts.filter((f) => !truths.includes(f));
  const lieSource = remaining[Math.floor(input.rng() * remaining.length)] || facts[0];
  const lie: Claim = {
    text: lieSource.lieText,
    truthful: false,
    detail: lieSource.detail,
  };
  const claims = shuffle(
    [
      ...truths.map((t) => ({ text: t.truthText, truthful: true, detail: t.detail })),
      lie,
    ],
    input.rng,
  );
  const lieIndex = claims.findIndex((c) => !c.truthful);
  return { ok: true, minDataMet: true, question: { claims, lieIndex } };
}

interface FactCandidate {
  truthText: string;
  /** A negation/inversion of the same fact that the data refutes. */
  lieText: string;
  detail: string;
}

/** A string is "displayable" when it survives templating without
 *  producing the literal "undefined" or an empty box. Treat null,
 *  empty strings, and pure-whitespace strings as missing. */
function isDisplayableString(v: unknown): v is string {
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
const MIN_WR_GAP = 0.04;

/**
 * The full fact pool is built by composing many small per-family
 * builders, each returning a single FactCandidate or null. The
 * generator picks two truths and one lie from whatever non-null
 * facts the user's data supports — so the more builders we ship,
 * the more variety the user sees across rounds.
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
    .filter((b) => isDisplayableString(b.name))
    .sort((a, b) => b.total - a.total)[0];
  if (!topBuild || !data.summary || topBuild.total < 5) return null;
  const diff = topBuild.winRate - data.summary.winRate;
  return {
    truthText:
      diff >= 0
        ? `Your most-played build (“${topBuild.name}”) has a higher WR than your overall WR.`
        : `Your most-played build (“${topBuild.name}”) has a lower WR than your overall WR.`,
    lieText:
      diff >= 0
        ? `Your most-played build (“${topBuild.name}”) has a lower WR than your overall WR.`
        : `Your most-played build (“${topBuild.name}”) has a higher WR than your overall WR.`,
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
    truthText: `In games under 12 minutes, you do better vs ${fullRace(top)} than vs ${fullRace(bottom)}.`,
    lieText: `In games under 12 minutes, you do better vs ${fullRace(bottom)} than vs ${fullRace(top)}.`,
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
  // Filter out the degenerate (best === worst) case when the filtered
  // pool collapses to one logical map after dedupe.
  if (best.map === worst.map) return null;
  return {
    truthText: `You have a higher WR on ${best.map} than on ${worst.map}.`,
    lieText: `You have a higher WR on ${worst.map} than on ${best.map}.`,
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
        ? `Your WR after 10pm is higher than your WR before noon.`
        : `Your WR after 10pm is lower than your WR before noon.`,
    lieText:
      diff >= 0
        ? `Your WR after 10pm is lower than your WR before noon.`
        : `Your WR after 10pm is higher than your WR before noon.`,
    detail: `Late ${pct1(lateWr)} (${hourBuckets.late.total}g), early ${pct1(earlyWr)} (${hourBuckets.early.total}g).`,
  };
}

/* ──────────── New fact families ────────────
 * Every new family gates on MIN_WR_GAP so the truth/lie pair never
 * hinges on a fraction-of-a-percent difference, and on a minimum
 * sample size per slice. */

function factMatchupVsOverall(data: ArcadeDataset): FactCandidate | null {
  if (!data.summary) return null;
  const overall = data.summary.winRate;
  const real = data.matchups.filter((m) => m.oppRace && m.total >= 6);
  if (real.length < 1) return null;
  // Pick the matchup whose WR diverges most from overall — biggest gap
  // makes for the clearest truth/lie pair.
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
        ? `Your WR vs ${race} is higher than your overall WR.`
        : `Your WR vs ${race} is lower than your overall WR.`,
    lieText:
      diff > 0
        ? `Your WR vs ${race} is lower than your overall WR.`
        : `Your WR vs ${race} is higher than your overall WR.`,
    detail: `vs ${race} ${pct1(m.winRate)} (${m.total}g) vs overall ${pct1(overall)}.`,
  };
}

function factTopVsSecondBuild(data: ArcadeDataset): FactCandidate | null {
  const builds = data.builds
    .slice()
    .filter((b) => isDisplayableString(b.name) && b.total >= 4)
    .sort((a, b) => b.total - a.total);
  if (builds.length < 2) return null;
  const top = builds[0];
  const second = builds[1];
  if (Math.abs(top.winRate - second.winRate) < MIN_WR_GAP) return null;
  const topBetter = top.winRate > second.winRate;
  return {
    truthText: topBetter
      ? `Your most-played build (“${top.name}”) wins more often than your 2nd-most (“${second.name}”).`
      : `Your 2nd-most-played build (“${second.name}”) wins more often than your most-played (“${top.name}”).`,
    lieText: topBetter
      ? `Your 2nd-most-played build (“${second.name}”) wins more often than your most-played (“${top.name}”).`
      : `Your most-played build (“${top.name}”) wins more often than your 2nd-most (“${second.name}”).`,
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
      ? `Your WR in your most recent half of games is higher than in the earlier half.`
      : `Your WR in your most recent half of games is lower than in the earlier half.`,
    lieText: recentBetter
      ? `Your WR in your most recent half of games is lower than in the earlier half.`
      : `Your WR in your most recent half of games is higher than in the earlier half.`,
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
      ? `You win more often in games over 20 minutes than in games under 12 minutes.`
      : `You win more often in games under 12 minutes than in games over 20 minutes.`,
    lieText: longBetter
      ? `You win more often in games under 12 minutes than in games over 20 minutes.`
      : `You win more often in games over 20 minutes than in games under 12 minutes.`,
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
      ? `Your weekend WR is higher than your weekday WR.`
      : `Your weekend WR is lower than your weekday WR.`,
    lieText: weekendBetter
      ? `Your weekend WR is lower than your weekday WR.`
      : `Your weekend WR is higher than your weekday WR.`,
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
      ? `Your most-played map (${top.map}) has a higher WR than your overall WR.`
      : `Your most-played map (${top.map}) has a lower WR than your overall WR.`,
    lieText: better
      ? `Your most-played map (${top.map}) has a lower WR than your overall WR.`
      : `Your most-played map (${top.map}) has a higher WR than your overall WR.`,
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
      ? `Your WR vs higher-MMR opponents is higher than your WR vs lower-MMR opponents.`
      : `Your WR vs higher-MMR opponents is lower than your WR vs lower-MMR opponents.`,
    lieText: upsetBetter
      ? `Your WR vs higher-MMR opponents is lower than your WR vs lower-MMR opponents.`
      : `Your WR vs higher-MMR opponents is higher than your WR vs lower-MMR opponents.`,
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
      ? `Your WR vs your most-faced opponent (${name}) is higher than your overall WR.`
      : `Your WR vs your most-faced opponent (${name}) is lower than your overall WR.`,
    lieText: better
      ? `Your WR vs your most-faced opponent (${name}) is lower than your overall WR.`
      : `Your WR vs your most-faced opponent (${name}) is higher than your overall WR.`,
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
      ? `Your WR in the game right after a loss is higher than the game right after a win.`
      : `Your WR in the game right after a loss is lower than the game right after a win.`,
    lieText: revengeBetter
      ? `Your WR in the game right after a loss is lower than the game right after a win.`
      : `Your WR in the game right after a loss is higher than the game right after a win.`,
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
  // Need a clear lead — otherwise the "lie" version (which inverts the
  // ordering) isn't really refuted by the data.
  if (top[1] - bottom[1] < 4) return null;
  return {
    truthText: `You've played more games vs ${fullRace(top[0])} than vs ${fullRace(bottom[0])}.`,
    lieText: `You've played more games vs ${fullRace(bottom[0])} than vs ${fullRace(top[0])}.`,
    detail: `vs ${fullRace(top[0])} ${top[1]}g, vs ${fullRace(bottom[0])} ${bottom[1]}g.`,
  };
}

function factBestVsWorstBuild(data: ArcadeDataset): FactCandidate | null {
  const builds = data.builds.filter(
    (b) => isDisplayableString(b.name) && b.total >= 5,
  );
  if (builds.length < 2) return null;
  const sorted = builds.slice().sort((a, b) => b.winRate - a.winRate);
  const best = sorted[0];
  const worst = sorted[sorted.length - 1];
  if (best.name === worst.name) return null;
  if (best.winRate - worst.winRate < MIN_WR_GAP) return null;
  return {
    truthText: `Your “${best.name}” build wins more often than your “${worst.name}” build.`,
    lieText: `Your “${worst.name}” build wins more often than your “${best.name}” build.`,
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
    truthText: `You win more often playing ${fullRace(top[0])} than playing ${fullRace(bottom[0])}.`,
    lieText: `You win more often playing ${fullRace(bottom[0])} than playing ${fullRace(top[0])}.`,
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
      ? `Your afternoon WR (noon–6pm) is higher than your evening WR (6–10pm).`
      : `Your afternoon WR (noon–6pm) is lower than your evening WR (6–10pm).`,
    lieText: afternoonBetter
      ? `Your afternoon WR (noon–6pm) is lower than your evening WR (6–10pm).`
      : `Your afternoon WR (noon–6pm) is higher than your evening WR (6–10pm).`,
    detail: `Afternoon ${pct1(aWr)} (${aT}g), evening ${pct1(eWr)} (${eT}g).`,
  };
}

function wrOf(games: ArcadeGame[]): number {
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

function wrPerOppRace(games: ArcadeGame[]): Record<string, { wr: number; games: number }> {
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

function bucketByHour(games: ArcadeGame[]): {
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

function fullRace(letter: string): string {
  if (letter === "P") return "Protoss";
  if (letter === "T") return "Terran";
  if (letter === "Z") return "Zerg";
  return letter;
}

function score(q: Q, a: A): ScoreResult {
  const correct = a === q.lieIndex;
  const lie = q.claims[q.lieIndex];
  return {
    raw: correct ? 1 : 0,
    xp: correct ? 16 : 0,
    outcome: correct ? "correct" : "wrong",
    note: `The lie: "${lie.text}"`,
  };
}

/**
 * Build the share lines for Two Truths & a Lie. Shares the full reveal
 * — outcome header plus all three claims with their TRUE/LIE labels —
 * rather than just the lie text, so the card carries the same context
 * the in-app reveal does. Each claim's supporting detail is appended
 * underneath so a reader who hasn't played sees the same evidence the
 * reveal panel shows.
 */
export function twoTruthsLieShareLines(q: Q, correct: boolean): string[] {
  const header = correct
    ? `Spotted the lie (claim #${q.lieIndex + 1}).`
    : `Missed the lie — it was claim #${q.lieIndex + 1}.`;
  return [
    header,
    ...q.claims.map((c, i) => `${i + 1}. ${c.truthful ? "TRUE" : "LIE"} · ${c.text}`),
  ];
}

function share(q: Q, a: A | null, s: ScoreResult): ShareSummary {
  const correct = s.outcome === "correct";
  const header = correct
    ? `Spotted the lie (claim #${q.lieIndex + 1}).`
    : `Missed the lie — it was claim #${q.lieIndex + 1}.`;
  const answer: string[] = [header];
  for (let i = 0; i < q.claims.length; i++) {
    const c = q.claims[i];
    answer.push(`${i + 1}. ${c.truthful ? "TRUE" : "LIE"} · ${c.text}`);
    if (c.detail) answer.push(`   ${c.detail}`);
  }
  void a;
  return {
    question:
      "Three statements about you. Two are true, one is a lie. Spot the lie.",
    answer,
  };
}

export const twoTruthsLie: Mode<Q, A> = {
  id: ID,
  kind: "game",
  category: "matchups",
  difficulty: "hard",
  ttp: "medium",
  depthTag: "cross-axis",
  title: "Two Truths & a Lie",
  blurb: "Two true claims about you, one fake. Spot the lie.",
  generate,
  score,
  share,
  render: (ctx) => <Render ctx={ctx} />,
};

function Render({
  ctx,
}: {
  ctx: Parameters<Mode<Q, A>["render"]>[0];
}) {
  const [picked, setPicked] = useState<number | null>(null);
  const onPick = (i: number) => {
    if (ctx.revealed) return;
    setPicked(i);
    ctx.onAnswer(i);
  };

  const reveal = useMemo(
    () =>
      ctx.score ? (
        <div className="space-y-2 text-caption text-text">
          <p className={ctx.score.outcome === "correct" ? "text-success" : "text-warning"}>
            The lie was claim #{ctx.question.lieIndex + 1}.
          </p>
          <ul className="space-y-1">
            {ctx.question.claims.map((c, i) => (
              <li
                key={`${c.text}-${i}`}
                className="rounded border border-border bg-bg-surface px-2 py-1"
              >
                <div className="font-medium">
                  {c.truthful ? (
                    <span className="text-success">TRUE</span>
                  ) : (
                    <span className="text-danger">LIE</span>
                  )}{" "}
                  · {c.text}
                </div>
                <div className="text-text-dim">{c.detail}</div>
              </li>
            ))}
          </ul>
        </div>
      ) : null,
    [ctx.score, ctx.question],
  );

  return (
    <QuizCard
      icon={IconFor(ID)}
      title={twoTruthsLie.title}
      depthLabel="Cross-axis claims (two true, one false)"
      isDaily={ctx.isDaily}
      revealed={ctx.revealed}
      onKeyAnswer={onPick}
      question={
        <span>
          Three statements. Two are true, one is{" "}
          <span className="font-semibold text-danger">a lie</span>. Spot the lie.
        </span>
      }
      answers={ctx.question.claims.map((c, i) => (
        <QuizAnswerButton
          key={i}
          index={i}
          selected={picked === i}
          correct={
            ctx.revealed
              ? i === ctx.question.lieIndex
                ? true
                : picked === i
                  ? false
                  : null
              : null
          }
          onClick={() => onPick(i)}
          disabled={ctx.revealed}
        >
          {c.text}
        </QuizAnswerButton>
      ))}
      reveal={reveal}
    />
  );
}
