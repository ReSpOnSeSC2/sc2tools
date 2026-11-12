import type { CommanderRow } from "./commanderEvidence";
import { COMMANDER_AXES, commanderAxisLabel, commanderCode, commanderName, type CommanderAxisKey } from "./commanderTaxonomy";

const MIN_BUILD_SAMPLE = 10;
const MIN_DURATION_SAMPLE = 10;
const MIN_MATCHUP_GAMES = 8;
const EPSILON = 1e-9;

type Axis = { category: string | null; sampleSize: number };
type Matchup = { matchup: string; wins: number; decidedGames: number };

export interface CommanderProfile {
  matchup: string;
  name: string;
  code: number | null;
  axes: Array<Axis & { key: CommanderAxisKey; label: string | null }>;
}

function repertoireCategory(diversity: number): string {
  if (diversity <= 1.5 + EPSILON) return "one_trick";
  if (diversity <= 2.5 + EPSILON) return "signature";
  if (diversity <= 5 + EPSILON) return "grinder";
  return diversity + EPSILON < 10 ? "adaptive" : "creative";
}

/** Keep these pure categories aligned with playerStyleFingerprint.js. */
export function commanderRepertoire(builds: readonly (string | null)[]): Axis {
  const counts = new Map<string, number>();
  let sampleSize = 0;
  for (const build of builds) {
    const name = build?.trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");
    if (!name || /game too short|unclassified|^(?:unknown|unsorted|n\/?a|none)$/.test(name)) continue;
    counts.set(name, (counts.get(name) ?? 0) + 1);
    sampleSize += 1;
  }
  if (sampleSize < MIN_BUILD_SAMPLE) return { category: null, sampleSize };
  const diversity = Math.exp(-[...counts.values()].reduce((sum, count) => {
    const share = count / sampleSize;
    return sum + share * Math.log(share);
  }, 0));
  return { category: repertoireCategory(diversity), sampleSize };
}

export function commanderPace(values: readonly (number | null)[]): Axis {
  const durations = values.filter((duration): duration is number => duration !== null && Number.isFinite(duration) && duration >= 45);
  const sampleSize = durations.length;
  if (sampleSize < MIN_DURATION_SAMPLE) return { category: null, sampleSize };
  const share = (test: (seconds: number) => boolean) => durations.filter(test).length / sampleSize;
  const short = share(seconds => seconds < 300);
  const late = share(seconds => seconds > 900);
  if (short >= 0.25 && late >= 0.25) return { category: "two_speed", sampleSize };
  if (late >= 0.8) return { category: "late_game_master", sampleSize };
  if (short >= 0.8) return { category: "cheeser", sampleSize };
  const long = share(seconds => seconds > 600);
  if (long >= 0.8) return { category: "mid_late_master", sampleSize };
  if (share(seconds => seconds >= 300 && seconds <= 600) >= 0.8) return { category: "timing_attacker", sampleSize };
  const average = durations.reduce((sum, seconds) => sum + seconds, 0) / sampleSize;
  return { category: average < 300 ? "cheeser" : average > 600 ? "late_game" : "flexible", sampleSize };
}

export function commanderEdge(matchup: string, rows: readonly Matchup[]): Axis {
  const selected = rows.find(row => row.matchup === matchup);
  const sampleSize = selected?.decidedGames ?? 0;
  if (!selected || rows.length !== 3 || rows.some(row => row.decidedGames < MIN_MATCHUP_GAMES)) return { category: null, sampleSize };
  const rate = (row: Matchup) => 100 * row.wins / row.decidedGames;
  const rates = rows.map(rate);
  const others = rows.filter(row => row !== selected);
  const delta = rate(selected) - (rate(others[0]) + rate(others[1])) / others.length;
  let category = delta >= -EPSILON ? "matchup_edge" : "matchup_hurdle";
  if (Math.max(...rates) - Math.min(...rates) <= 5 + EPSILON) category = "universalist";
  else if (delta + EPSILON >= 10) category = "specialist";
  else if (delta <= -10 + EPSILON) category = "blind_spot";
  return { category, sampleSize };
}

function matchupCounts(matchup: string, rows: readonly CommanderRow[]): Matchup {
  const count = { matchup, wins: 0, decidedGames: 0 };
  for (const row of rows) {
    if (row.matchup !== matchup) continue;
    const result = row.result.trim().toLowerCase();
    if (result === "victory" || result === "win") { count.wins += 1; count.decidedGames += 1; }
    else if (result === "defeat" || result === "loss") count.decidedGames += 1;
  }
  return count;
}

export function buildCommanderProfile(rows: readonly CommanderRow[]): CommanderProfile | null {
  const groups = new Map<string, CommanderRow[]>();
  for (const row of rows) {
    const group = groups.get(row.matchup);
    if (group) group.push(row);
    else groups.set(row.matchup, [row]);
  }
  const [matchup, selected] = [...groups].sort(([a, left], [b, right]) => right.length - left.length || a.localeCompare(b))[0] ?? [];
  if (!matchup || !selected) return null;
  const repertoire = commanderRepertoire(selected.map(row => row.myBuild));
  const pace = commanderPace(selected.map(row => row.durationSec));
  const edge = commanderEdge(matchup, [..."PTZ"].map(race => matchupCounts(matchup.slice(0, 2) + race, rows)));
  const categories = [repertoire.category, pace.category, edge.category] as const;
  return { matchup, name: commanderName(categories), code: commanderCode(categories), axes: [repertoire, pace, edge].map((axis, index) => {
    const key = COMMANDER_AXES[index];
    return { ...axis, key, label: commanderAxisLabel(key, axis.category) };
  }) };
}
