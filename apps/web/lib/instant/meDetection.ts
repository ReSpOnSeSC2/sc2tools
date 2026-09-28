/**
 * "Which player is me?" for a batch of replays.
 *
 * The gameId the cloud dedupes on embeds the OPPONENT's name, so picking
 * the wrong "me" silently creates duplicate games. Resolution therefore
 * follows the desktop agent first and only then falls back to softer
 * evidence, asking the visitor to confirm whenever we are guessing:
 *
 *   1. path   — the file's relative path contains a toon folder
 *               (`1-S2-1-267727`): that toon, exactly (agent rule).
 *   2. profile — a player whose toon is one of the signed-in user's
 *               saved toon handles.
 *   3. majority — across the remaining loose files, the toon present in
 *               at least `threshold` of them (one-tap confirmation).
 *   4. ambiguous — a single loose file or a tie: the visitor chooses.
 *
 * Files where the chosen toon did not play get a null selector and are
 * reported as `player_unresolved` by the caller.
 *
 * Example:
 *   const me = detectMe(scans, { profileToons: ["1-S2-1-267727"] });
 *   const selector = me.selectorFor(scans[0].key); // { toon, handle } | null
 */
import type { PlayerSelector, ReplayPlayer } from "./types";

/** Default share of loose files a toon must appear in to be "me". */
export const DEFAULT_MAJORITY_THRESHOLD = 0.6;
/** A majority needs at least this many loose files to mean anything. */
const MIN_FILES_FOR_MAJORITY = 2;

export interface MeScan {
  key: string;
  players: ReplayPlayer[];
  toonFromPath: string | null;
}

export interface MeDetectionOptions {
  profileToons?: ReadonlyArray<string>;
  threshold?: number;
}

export type MeDetectionMode = "path" | "profile" | "majority" | "ambiguous" | "none";

export interface MeCandidate {
  toon: string;
  /** Most frequent display name seen for this toon. */
  name: string;
  /** Most frequent race seen for this toon. */
  race: string;
  /** Files this toon appears in (within the set the mode is about). */
  games: number;
}

export interface MeDetection {
  mode: MeDetectionMode;
  needsConfirmation: boolean;
  candidates: MeCandidate[];
  /** Selector for one file; `chosenToon` overrides a majority/ambiguous guess. */
  selectorFor(key: string, chosenToon?: string | null): PlayerSelector | null;
}

type Resolution = { via: "path" | "profile"; toon: string } | { via: "loose" };

interface Tally {
  toon: string;
  games: number;
  names: Map<string, number>;
  races: Map<string, number>;
}

/**
 * Resolve "me" for every scanned file (see module comment for rules).
 *
 * Example:
 *   detectMe([{ key: "k", players, toonFromPath: "1-S2-1-5" }]).mode; // -> "path"
 */
export function detectMe(
  scans: ReadonlyArray<MeScan>,
  options: MeDetectionOptions = {},
): MeDetection {
  const threshold = options.threshold ?? DEFAULT_MAJORITY_THRESHOLD;
  const profile = new Set(options.profileToons ?? []);
  const byKey = new Map<string, MeScan>();
  const resolutions = new Map<string, Resolution>();
  for (const scan of scans) {
    byKey.set(scan.key, scan);
    resolutions.set(scan.key, resolveOne(scan, profile));
  }
  const loose = scans.filter((scan) => resolutions.get(scan.key)?.via === "loose");
  const outcome = classify(scans, resolutions, loose, threshold);
  return {
    ...outcome,
    selectorFor(key: string, chosenToon?: string | null): PlayerSelector | null {
      const scan = byKey.get(key);
      const resolution = resolutions.get(key);
      if (!scan || !resolution) return null;
      const toon = resolution.via === "loose" ? chosenToon || outcome.defaultToon : resolution.toon;
      return selectorForToon(scan, toon);
    },
  };
}

function humanToons(scan: MeScan): string[] {
  const toons: string[] = [];
  for (const player of scan.players) {
    if (player.toon && !toons.includes(player.toon)) toons.push(player.toon);
  }
  return toons;
}

function resolveOne(scan: MeScan, profile: ReadonlySet<string>): Resolution {
  if (scan.toonFromPath) return { via: "path", toon: scan.toonFromPath };
  const matches = humanToons(scan).filter((toon) => profile.has(toon));
  if (matches.length === 1) return { via: "profile", toon: matches[0] };
  return { via: "loose" };
}

function selectorForToon(scan: MeScan, toon: string | null): PlayerSelector | null {
  if (!toon) return null;
  const player = scan.players.find((candidate) => candidate.toon === toon);
  if (!player) return null;
  return { toon, handle: player.name || null };
}

interface Classification {
  mode: MeDetectionMode;
  needsConfirmation: boolean;
  candidates: MeCandidate[];
  defaultToon: string | null;
}

function classify(
  scans: ReadonlyArray<MeScan>,
  resolutions: ReadonlyMap<string, Resolution>,
  loose: ReadonlyArray<MeScan>,
  threshold: number,
): Classification {
  if (loose.length === 0) return classifyResolved(scans, resolutions);
  const candidates = tallyCandidates(loose.map((scan) => ({ scan, toons: humanToons(scan) })));
  if (candidates.length === 0) {
    return { mode: "none", needsConfirmation: false, candidates, defaultToon: null };
  }
  const [top, second] = candidates;
  const reachesThreshold = top.games >= threshold * loose.length;
  const isUniqueTop = !second || second.games < top.games;
  if (loose.length >= MIN_FILES_FOR_MAJORITY && reachesThreshold && isUniqueTop) {
    return { mode: "majority", needsConfirmation: true, candidates, defaultToon: top.toon };
  }
  return { mode: "ambiguous", needsConfirmation: true, candidates, defaultToon: null };
}

function classifyResolved(
  scans: ReadonlyArray<MeScan>,
  resolutions: ReadonlyMap<string, Resolution>,
): Classification {
  let usedProfile = false;
  const rows: Array<{ scan: MeScan; toons: string[] }> = [];
  for (const scan of scans) {
    const resolution = resolutions.get(scan.key);
    if (!resolution || resolution.via === "loose") continue;
    if (resolution.via === "profile") usedProfile = true;
    rows.push({ scan, toons: [resolution.toon] });
  }
  const candidates = tallyCandidates(rows);
  if (rows.length === 0) {
    return { mode: "none", needsConfirmation: false, candidates, defaultToon: null };
  }
  const mode: MeDetectionMode = usedProfile ? "profile" : "path";
  return { mode, needsConfirmation: false, candidates, defaultToon: null };
}

/** Count files per toon and pick each toon's most common name and race. */
function tallyCandidates(
  rows: ReadonlyArray<{ scan: MeScan; toons: ReadonlyArray<string> }>,
): MeCandidate[] {
  const tallies = new Map<string, Tally>();
  for (const { scan, toons } of rows) {
    for (const toon of toons) {
      const tally = tallies.get(toon) ?? newTally(toon);
      tallies.set(toon, tally);
      tally.games += 1;
      for (const player of scan.players) {
        if (player.toon !== toon) continue;
        bump(tally.names, player.name);
        bump(tally.races, player.race);
      }
    }
  }
  return [...tallies.values()]
    .map((tally) => ({
      toon: tally.toon,
      name: mostFrequent(tally.names),
      race: mostFrequent(tally.races),
      games: tally.games,
    }))
    .sort((a, b) => b.games - a.games || a.name.localeCompare(b.name) || a.toon.localeCompare(b.toon));
}

function newTally(toon: string): Tally {
  return { toon, games: 0, names: new Map(), races: new Map() };
}

function bump(counts: Map<string, number>, value: string): void {
  if (!value) return;
  counts.set(value, (counts.get(value) ?? 0) + 1);
}

/** Highest count wins; ties keep first-seen order (Map preserves insertion). */
function mostFrequent(counts: ReadonlyMap<string, number>): string {
  let best = "";
  let bestCount = 0;
  for (const [value, count] of counts) {
    if (count > bestCount) {
      best = value;
      bestCount = count;
    }
  }
  return best;
}
