"use strict";

/**
 * Exact, database-independent explorer calculations. Callers provide scoped
 * records; chronology views additionally receive earlier / filtered-out games
 * with matches:false. Those games establish context but never enter results.
 * gameKeys are internal memberships for the corresponding replay drilldown.
 */

/** @typedef {Record<string, any>} Game */
/** @typedef {Record<string, any>} Options */
/** @typedef {{key:string,label:string,records:Game[],extra:Record<string,any>}} Bucket */

const BREAK_BUCKETS = [
  { key: "under-2", label: "Under 2 minutes", min: 0, max: 120 },
  { key: "2-5", label: "2–5 minutes", min: 120, max: 300 },
  { key: "5-15", label: "5–15 minutes", min: 300, max: 900 },
  { key: "15-30", label: "15–30 minutes", min: 900, max: 1800 },
  { key: "30-60", label: "30–60 minutes", min: 1800, max: 3600 },
  { key: "1-4-hours", label: "1–4 hours", min: 3600, max: 14400 },
  { key: "4-plus-hours", label: "4+ hours", min: 14400, max: Infinity },
];
const REMATCH_BUCKETS = [
  { key: "first", label: "First meeting" },
  { key: "second", label: "Second meeting" },
  { key: "third", label: "Third meeting" },
  { key: "fourth-plus", label: "Fourth meeting onward" },
];

/** @param {Game} game */
function gameKey(game) { return `${game.userId}|${game.gameId}`; }

/** Stable account identity; unknown histories remain separate by uploader.
 * @param {Game} game */
function playerId(game) {
  return nonempty(game.playerId) || nonempty(game.myToonHandle)
    || nonempty(game.myAccount?.toonHandle) || `user:${String(game.userId)}`;
}

/** @param {unknown} value */
function nonempty(value) { return typeof value === "string" ? value.trim() : ""; }
/** @param {unknown} value */
function finite(value) { return typeof value === "number" && Number.isFinite(value); }
/** @param {unknown} value */
function timestamp(value) {
  if (!(value instanceof Date) && typeof value !== "string") return null;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : null;
}
/** @param {unknown} value */
function race(value) {
  const letter = nonempty(value).slice(0, 1).toUpperCase();
  return ["P", "T", "Z", "R"].includes(letter) ? letter : "U";
}
/** @param {Game} game */
function outcome(game) {
  const result = nonempty(game.result).toLowerCase();
  return result === "victory" || result === "win" ? "win"
    : result === "defeat" || result === "loss" ? "loss" : "other";
}
/** @param {Game} game */
function duration(game) {
  const value = finite(game.durationSec) ? game.durationSec : game.duration;
  return finite(value) && value >= 0 ? Number(value) : null;
}
/** @param {Game} game */
function historicalMmr(game) {
  if (game.myMmrSource === "replay" && validRating(game.myMmr)) return Number(game.myMmr);
  const recovered = game.trendsExplorerDetail?.ratings?.myMmr;
  return validRating(recovered) ? Number(recovered) : null;
}
/** Numeric legacy opponent ratings may be server-enriched current ratings.
 * Only explicit replay provenance establishes a game-time MMR difference.
 * @param {Game} game */
function historicalOpponentMmr(game) {
  const opponent = game.opponent || {};
  if (opponent.mmrSource === "replay" && validRating(opponent.mmr)) return Number(opponent.mmr);
  const recovered = game.trendsExplorerDetail?.ratings?.opponentMmr;
  return validRating(recovered) ? Number(recovered) : null;
}
/** Mirrors the replay parser's bounds; small league enums are not ratings.
 * @param {unknown} value */
function validRating(value) { return typeof value === "number" && Number.isInteger(value) && value >= 500 && value <= 9999; }
/** @param {Game} game */
function selected(game) { return game.matches !== false && game.isResumedFromReplay !== true; }

/** @param {string} key @param {string} label @param {Record<string,any>} [extra] @returns {Bucket} */
function bucket(key, label, extra = {}) { return { key, label, records: [], extra }; }

/** @param {Bucket} value @param {Options} options */
function finishBucket(value, options) {
  let wins = 0, losses = 0, seconds = 0, durations = 0, mmrSum = 0, mmrs = 0;
  /** @type {Map<string,{wins:number,decided:number}>} */
  const players = new Map();
  for (const game of value.records) {
    const result = outcome(game), id = playerId(game);
    const player = players.get(id) || { wins: 0, decided: 0 };
    if (result === "win") { wins += 1; player.wins += 1; }
    if (result === "loss") losses += 1;
    if (result !== "other") player.decided += 1;
    players.set(id, player);
    const length = duration(game), mmr = historicalMmr(game);
    if (length !== null) { seconds += length; durations += 1; }
    if (mmr !== null) { mmrSum += mmr; mmrs += 1; }
  }
  const decided = wins + losses;
  const ratedPlayers = [...players.values()].filter((p) => p.decided > 0);
  const winRate = options.weight === "players"
    ? ratedPlayers.length ? ratedPlayers.reduce((sum, p) => sum + p.wins / p.decided, 0) / ratedPlayers.length : null
    : decided ? wins / decided : null;
  return {
    key: value.key, label: value.label, games: value.records.length, wins, losses, decided,
    winRate, players: players.size, decidedPlayers: ratedPlayers.length,
    avgDurationSec: durations ? seconds / durations : null, durationGames: durations,
    avgMmr: mmrs ? mmrSum / mmrs : null, mmrGames: mmrs,
    ...value.extra, gameKeys: value.records.map(gameKey),
  };
}

/** @param {Bucket[]} buckets @param {Options} options @param {string[]} [notes] */
function finish(buckets, options, notes = []) {
  const rows = buckets.map((value) => finishBucket(value, options));
  return { rows, eligibleGames: new Set(rows.flatMap((row) => row.gameKeys)).size, notes };
}

/** @param {Game[]} records @param {Options} options */
function mmrGap(records, options) {
  const width = [100, 200, 500].includes(options.gapWidth) ? Number(options.gapWidth) : 200;
  /** @type {Map<number,Bucket>} */
  const buckets = new Map();
  for (const game of records) {
    if (!selected(game)) continue;
    const mine = historicalMmr(game), theirs = historicalOpponentMmr(game);
    if (mine === null || theirs === null) continue;
    const gap = theirs - mine;
    const lower = Math.floor((gap + width / 2) / width) * width - width / 2;
    const upper = lower + width;
    if (!buckets.has(lower)) buckets.set(lower, bucket(`gap:${lower}:${upper}`, `${signed(lower)} to ${signed(upper - 1)}`, { lower, upper }));
    buckets.get(lower)?.records.push(game);
  }
  return finish([...buckets.entries()].sort(([a], [b]) => a - b).map(([, value]) => value), options, [
    "Difference is opponent MMR minus player MMR. Positive values mean a higher-rated opponent.",
    "Only ratings explicitly recorded from the replay are included; current ladder ratings are never substituted.",
  ]);
}
/** @param {number} value */
function signed(value) { return value > 0 ? `+${value}` : String(value); }

/** Date bounds arrive validated, including the selected end day's final millisecond.
 * @param {Game[]} records @param {Options} options */
function periods(records, options) {
  const groups = [bucket("a", "Period A"), bucket("b", "Period B")];
  const bounds = [
    [timestamp(options.aSince), timestamp(options.aUntil)],
    [timestamp(options.bSince), timestamp(options.bUntil)],
  ];
  for (const game of records) {
    if (!selected(game)) continue;
    const time = timestamp(game.date);
    if (time === null) continue;
    bounds.forEach(([since, until], index) => {
      if (since !== null && until !== null && time >= since && time <= until) groups[index].records.push(game);
    });
  }
  return {
    ...finish(groups, options, ["Periods use inclusive date bounds and the same remaining game and player filters. Overlapping dates contribute to both periods."]),
    breakdown: comparisonBreakdown(groups, options),
  };
}

/** @param {Game[]} records @param {Options} options */
function groups(records, options) {
  const result = [bucket("a", "Group A"), bucket("b", "Group B")];
  const specs = [
    { min: options.aMin, max: options.aMax, ids: new Set(options.aPlayers || []) },
    { min: options.bMin, max: options.bMax, ids: new Set(options.bPlayers || []) },
  ];
  for (const game of records) {
    if (!selected(game)) continue;
    const mmr = historicalMmr(game);
    specs.forEach((spec, index) => {
      const belongs = options.groupMode === "players" ? spec.ids.has(playerId(game))
        : mmr !== null && (!finite(spec.min) || mmr >= spec.min) && (!finite(spec.max) || mmr < spec.max);
      if (belongs) result[index].records.push(game);
    });
  }
  return {
    ...finish(result, options, [options.groupMode === "players"
      ? "Groups contain only selected accounts within the current authorized player population. An account selected in both groups contributes to both."
      : "MMR ranges use each game's replay-recorded player rating. The minimum is included and the maximum is excluded, so adjacent ranges do not overlap.",
    options.weight === "players" ? "Win rate gives each account with decided games equal weight. Game totals remain exact."
      : "Win rate gives each decided game equal weight."]),
    breakdown: comparisonBreakdown(result, options),
  };
}

/** @param {Bucket[]} groups @param {Options} options */
function comparisonBreakdown(groups, options) {
  /** @type {Array<Record<string,any>>} */
  const rows = [];
  for (const group of groups) {
    for (const kind of ["matchup", "build"]) {
      /** @type {Map<string,Bucket>} */
      const buckets = new Map();
      for (const game of group.records) {
        const label = kind === "matchup" ? `${race(game.myRace)}v${race(game.opponent?.race)}` : nonempty(game.myBuild) || "Unknown build";
        if (!buckets.has(label)) buckets.set(label, bucket(`${group.key}:${kind}:${label}`, label));
        buckets.get(label)?.records.push(game);
      }
      for (const value of [...buckets.values()].sort((a, b) => b.records.length - a.records.length || a.label.localeCompare(b.label))) {
        rows.push({ ...finishBucket(value, options), group: group.key, kind });
      }
    }
  }
  return rows;
}

/** Keep queue, selected race and spawned race distinct. Unknown-account
 * histories cannot establish an account-to-account sequence safely.
 * @param {Game} game */
function sequenceKey(game) {
  const id = playerId(game);
  if (!id || id.startsWith("user:")) return null;
  const format = nonempty(game.matchFormat) || (game.playerCount === 2 ? "1v1" : "unknown");
  const queue = game.isLadderGame === true ? "ladder" : game.isLadderGame === false ? "custom" : "unknown";
  return JSON.stringify([id, race(game.myRace), race(game.myLadderRace || game.myRace), queue, format, game.playerCount ?? null]);
}

/** Exact start is preferred; legacy replay date is its end time.
 * @param {Game} game */
function startTime(game) {
  const end = timestamp(game.date), exact = timestamp(game.startedAt);
  if (end === null) return null;
  if (exact !== null) return exact <= end ? exact : null;
  const seconds = duration(game);
  return seconds !== null && seconds > 0 ? end - seconds * 1000 : null;
}

/** Sorting replay ends also places a missing-duration predecessor correctly.
 * Such a record can establish its end and prior outcome, but cannot itself
 * produce an inferred start. Ties are stable and cannot fabricate a break.
 * @param {Game[]} records */
function chronology(records) {
  return records.filter((game) => game.isResumedFromReplay !== true && timestamp(game.date) !== null)
    .slice().sort((a, b) => Number(timestamp(a.date)) - Number(timestamp(b.date)) || gameKey(a).localeCompare(gameKey(b)));
}

/** @param {Game|undefined} previous @param {Options} options */
function afterMatches(previous, options) {
  return options.after !== "win" && options.after !== "loss" || !!previous && outcome(previous) === options.after;
}

/** @param {Game[]} records @param {Options} options */
function breaks(records, options) {
  const buckets = BREAK_BUCKETS.map((row) => bucket(row.key, row.label, { minSeconds: row.min, maxSeconds: Number.isFinite(row.max) ? row.max : null }));
  /** @type {Map<string,Game>} */
  const previous = new Map();
  for (const game of chronology(records)) {
    const key = sequenceKey(game);
    if (key === null) continue;
    // Find the immediate predecessor before comparing queue/race context.
    // Skipping another-race game would mislabel that active play as rest.
    const account = playerId(game);
    const prior = previous.get(account);
    previous.set(account, game);
    if (!selected(game) || !prior || sequenceKey(prior) !== key || !afterMatches(prior, options)) continue;
    const start = startTime(game), end = timestamp(prior.date);
    if (start === null || end === null || start < end) continue;
    const gap = (start - end) / 1000;
    const index = BREAK_BUCKETS.findIndex((row) => gap >= row.min && gap < row.max);
    if (index >= 0) buckets[index].records.push(game);
  }
  return finish(buckets, options, [
    "Break length is the next game's start minus the immediately previous stored game's end. Only consecutive games in the same account, race and game mode qualify.",
    "Filtered-out games still establish the previous result and break. Missing uploads can make a gap look longer; these patterns do not establish cause and effect.",
  ]);
}

/** Never join on a display name (including barcode and anonymous names).
 * Older agents used pulseId for either a toon or numeric Pulse character ID.
 * @param {Game} game */
function opponentIdentityParts(game) {
  const opponent = game.opponent || {};
  const handle = [nonempty(opponent.toonHandle), nonempty(opponent.pulseId)].find((value) => /^[1-6]-S2-\d+-\d+$/i.test(value));
  const canonical = [nonempty(opponent.pulseCharacterId), nonempty(opponent.pulseId)].find((value) => /^\d+$/.test(value));
  return { toon: handle ? `toon:${handle.toUpperCase()}` : null, pulse: canonical ? `pulse:${canonical}` : null };
}

/** A later record can prove that two stable identifiers name the same account.
 * Conflicting mappings remain separate instead of guessing an identity.
 * @param {Game[]} records */
function opponentAliases(records) {
  /** @type {Map<string,string|null>} */
  const aliases = new Map();
  for (const game of records) {
    const { toon, pulse } = opponentIdentityParts(game);
    if (!toon || !pulse || game.isResumedFromReplay === true) continue;
    if (!aliases.has(pulse)) aliases.set(pulse, toon);
    else if (aliases.get(pulse) !== toon) aliases.set(pulse, null);
  }
  return aliases;
}

/** @param {Game[]} records @param {Options} options */
function rematches(records, options) {
  const buckets = REMATCH_BUCKETS.map((row) => bucket(row.key, row.label));
  const aliases = opponentAliases(records);
  /** @type {Map<string,{count:number,previous:Game}>} */
  const meetings = new Map();
  for (const game of chronology(records)) {
    const own = sequenceKey(game), parts = opponentIdentityParts(game);
    const opponent = parts.toon || (parts.pulse ? aliases.get(parts.pulse) || parts.pulse : null);
    if (own === null || opponent === null) continue;
    const key = JSON.stringify([own, opponent, race(game.opponent?.race)]);
    const history = meetings.get(key);
    const count = (history?.count || 0) + 1;
    meetings.set(key, { count, previous: game });
    if (!selected(game) || !afterMatches(history?.previous, options)) continue;
    buckets[Math.min(count - 1, 3)].records.push(game);
  }
  return finish(buckets, options, [
    "Meeting numbers use all stored history for the same account, player race, opponent identity and race, and game mode. Name-only opponents are excluded.",
    "The prior-result filter refers to the previous meeting with that opponent. Missing uploads may omit earlier meetings.",
  ]);
}

/** @param {string} view @param {Game[]} records @param {Options} [options] */
function analyzeSummary(view, records, options = {}) {
  if (view === "mmr-gap") return mmrGap(records, options);
  if (view === "periods") return periods(records, options);
  if (view === "groups") return groups(records, options);
  if (view === "breaks") return breaks(records, options);
  if (view === "rematches") return rematches(records, options);
  throw new Error(`Unsupported summary explorer view: ${view}`);
}

module.exports = { analyzeSummary, gameKey, historicalMmr, historicalOpponentMmr };
