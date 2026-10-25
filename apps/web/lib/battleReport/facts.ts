import type { GameBuildOrderEvent, GameSummary } from "@/components/analyzer/game/types";
import type { MacroBreakdownData } from "@/components/analyzer/macro/MacroBreakdownPanel.types";
import type { MapPlayback } from "../mapReplay";
import { gameStory, type GameStory, type StoryFight } from "../gameStory";
import { patchEraForGame } from "../ladderPulse";
import { humanizeBuildName } from "../build-events";

export type ReportTone = "battle" | "caster" | "tactical";
export type ReportBeat = "setting" | "opening" | "turning" | "aftermath";
export type ReportFact = { id: string; text: string; time: number; timestamps: number[]; source: string };
export type SnapshotMoment = { id: string; time: number; caption: string; point?: { x: number; y: number } };
export type StoryFacts = {
  gameId: string; map: string | null; date: string | null; length: number | null;
  entries: Record<string, ReportFact>; beats: Record<ReportBeat, string[]>;
  moments: SnapshotMoment[]; story: GameStory; shape: "short" | "comeback" | "swings" | "steady";
};
export type BattleReportInput = {
  game: GameSummary; myName?: string | null; plannedBuild?: string | null;
  buildEvents?: readonly GameBuildOrderEvent[] | null; oppBuildEvents?: readonly GameBuildOrderEvent[] | null;
  breakdown?: MacroBreakdownData | null; playback?: MapPlayback | null; story?: GameStory;
};

const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
const nonnegative = (n: unknown): n is number => finite(n) && n >= 0;
const clock = (n: number) => `${Math.floor(n / 60)}:${String(Math.floor(n % 60)).padStart(2, "0")}`;
const text = (value: unknown) => typeof value === "string" && value.trim() ? value.trim() : null;
const TOWNHALLS = new Set(["Hatchery", "Nexus", "CommandCenter"]);
const TECH = new Set(["CyberneticsCore", "TwilightCouncil", "Stargate", "RoboticsFacility", "Spire", "RoachWarren", "BanelingNest", "HydraliskDen", "InfestationPit", "Factory", "Starport", "FusionCore", "GhostAcademy"]);

/** Facts only: missing telemetry stays absent. No endpoint, model or clock read. */
export function battleReportFacts(input: BattleReportInput): StoryFacts {
  const { game, breakdown, playback } = input;
  const length = nonnegative(game.durationSec) ? game.durationSec : nonnegative(breakdown?.game_length_sec) ? breakdown.game_length_sec : null;
  const entries: StoryFacts["entries"] = {}, beats: StoryFacts["beats"] = { setting: [], opening: [], turning: [], aftermath: [] };
  const add = (beat: ReportBeat, id: string, content: string, time: number, source: string, timestamps = [time]) => {
    if (!nonnegative(time) || length !== null && time > length) return;
    entries[id] = { id, text: content, time, timestamps: timestamps.filter(n => nonnegative(n) && (length === null || n <= length)), source };
    beats[beat].push(id);
  };
  const me = text(input.myName) ?? text(breakdown?.player_stats?.me?.name) ?? "You";
  const opponent = text(game.opponent?.displayName) ?? text(breakdown?.player_stats?.opponent?.name) ?? "your opponent";
  const map = text(game.map), matchup = [text(game.myRace), text(game.opponent?.race)].filter(Boolean).join(" versus ");
  add("setting", "setting", `${me} faced ${opponent}${matchup ? ` in ${matchup}` : ""}${map ? ` on ${map}` : ""}`, 0, "game metadata");
  if (nonnegative(game.myMmr) && nonnegative(game.opponent?.mmr)) add("setting", "mmr", `The replay listed ${game.myMmr} MMR for you and ${game.opponent.mmr} for your opponent`, 0, "game metadata");
  const planned = text(input.plannedBuild), classified = text(game.detectedBuild) ?? text(game.myBuild);
  if (planned) add("setting", "plan", `Your checked-in plan was ${planned}${classified ? `; the replay classifier named ${classified}` : ""}`, 0, "build check-in and classifier");
  else if (classified) add("setting", "opener", `Your replay-classified opening was ${classified}`, 0, "replay classifier");
  const theirOpening = text(game.detectedOppStrategy) ?? text(game.opponent?.strategy);
  if (theirOpening) add("setting", "opponent-opener", `The opponent's replay-classified opening was ${theirOpening}`, 0, "replay classifier");

  const ordered = (input.buildEvents ?? []).filter(row => nonnegative(row.time) && row.time > 0 && (length === null || row.time <= length) && text(row.name)).slice().sort((a, b) => a.time - b.time || a.name.localeCompare(b.name));
  const natural = ordered.find(row => row.time > 10 && TOWNHALLS.has(row.name));
  if (natural) add("opening", "natural", `Your first expansion, ${natural.display || humanizeBuildName(natural.name)}, started at ${clock(natural.time)}`, natural.time, "build events");
  const gas = ordered.find(row => /^(Extractor|Assimilator|Refinery)(Rich)?$/.test(row.name));
  if (gas) add("opening", "gas", `Your first recorded gas structure, ${gas.display || humanizeBuildName(gas.name)}, started at ${clock(gas.time)}`, gas.time, "build events");
  const tech = ordered.find(row => TECH.has(row.name));
  if (tech) add("opening", "tech", `Your first recorded tech structure, ${tech.display || humanizeBuildName(tech.name)}, started at ${clock(tech.time)}`, tech.time, "build events");
  const upgrade = ordered.filter(row => row.category === "upgrade" && nonnegative(row.complete_time)).sort((a, b) => a.complete_time! - b.complete_time!)[0];
  if (upgrade) add("opening", "upgrade", `${upgrade.display || upgrade.name} completed at ${clock(upgrade.complete_time!)}`, upgrade.complete_time!, "build completion event");
  if (playback?.fidelity?.attacks === "observed") {
    let first = Infinity;
    for (const rows of [playback.units, playback.buildings]) for (const row of rows) for (const shot of row.attacks ?? []) if (nonnegative(shot)) first = Math.min(first, shot);
    if (finite(first)) add("opening", "first-attack", `The first observed weapon cycle was at ${clock(first)}`, first, "observed playback attacks");
  }

  const story = input.story ?? gameStory({ gameId: game.gameId, result: game.result, statsEvents: breakdown?.stats_events, oppStatsEvents: breakdown?.opp_stats_events, casualtyEvents: breakdown?.casualty_events, buildEvents: input.buildEvents, patchEra: patchEraForGame(game), supplyBlockedSeconds: breakdown?.raw?.supply_blocked_seconds, supplyBlockWindows: breakdown?.raw?.supply_block_windows, leaks: breakdown?.all_leaks ?? breakdown?.top_3_leaks });
  const fights = story.fights;
  const describeFight = (fight: StoryFight) => {
    const loss = (side: StoryFight["me"]) => fight.estimated ? side.estimatedValue === undefined ? "an unmeasured resource loss" : `an estimated ${Math.round(side.estimatedValue)} resources` : `${Math.round(side.minerals)} minerals and ${Math.round(side.gas)} gas${side.unpriced ? `, plus ${side.unpriced} unpriced deaths` : ""}`;
    return `${fight.estimated ? "The estimated army-drop window" : "The recorded casualty cluster"} at ${clock(fight.start)}–${clock(fight.end)} showed ${loss(fight.me)} lost by you and ${loss(fight.opp)} by your opponent`;
  };
  if (fights[0]) add("opening", "first-clash", describeFight(fights[0]), fights[0].start, "fight ledger", [fights[0].start, fights[0].end]);
  const largest = story.turningPoints.slice().sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta) || a.time - b.time)[0];
  if (largest) add("turning", "largest-swing", `The largest sampled lead swing ended at ${clock(largest.time)}: ${Math.abs(largest.delta).toFixed(1)} points ${largest.delta > 0 ? "toward you" : "toward your opponent"} on the relative army, worker and income index`, largest.time, "thirty-second lead series");
  const known = story.leadSeries.filter(row => finite(row.combinedLead));
  const comeback = known.some((row, index) => row.combinedLead! < -.1 && known.slice(index + 1).some(later => later.combinedLead! > .1));
  if (comeback) {
    const reversed = known.find((row, index) => row.combinedLead! > .1 && known.slice(0, index).some(before => before.combinedLead! < -.1))!;
    add("turning", "comeback", `The sampled combined lead moved from your opponent's side to yours by ${clock(reversed.time)}`, reversed.time, "lead series");
  }
  const priced = fights.filter(row => !row.me.unpriced && !row.opp.unpriced && (!row.estimated || row.me.estimatedValue !== undefined && row.opp.estimatedValue !== undefined));
  const biggestFight = priced.slice().sort((a, b) => ((b.me.estimatedValue ?? b.me.minerals + b.me.gas) + (b.opp.estimatedValue ?? b.opp.minerals + b.opp.gas)) - ((a.me.estimatedValue ?? a.me.minerals + a.me.gas) + (a.opp.estimatedValue ?? a.opp.minerals + a.opp.gas)) || a.start - b.start)[0];
  if (biggestFight && biggestFight !== fights[0]) add("turning", "largest-fight", describeFight(biggestFight), biggestFight.start, "fight ledger", [biggestFight.start, biggestFight.end]);
  const townhallLosses = (breakdown?.casualty_events ?? []).filter(row => row.category === "buildings" && TOWNHALLS.has(row.name) && nonnegative(row.time)).slice().sort((a, b) => a.time - b.time);
  const exchange = townhallLosses.find((row, index) => townhallLosses.slice(index + 1).some(other => other.owner !== row.owner && other.time - row.time <= 45));
  if (exchange) add("turning", "townhall-exchange", `Both players lost a recorded town hall within a ${45}-second window beginning at ${clock(exchange.time)}`, exchange.time, "building casualties");

  const result = text(game.result);
  if (result) add("aftermath", "result", `The replay result was ${result}${length !== null ? ` after ${clock(length)}` : ""}`, length ?? 0, "game metadata");
  const workerPeak = (breakdown?.stats_events ?? []).filter(row => nonnegative(row.food_workers) && nonnegative(row.time)).slice().sort((a, b) => b.food_workers! - a.food_workers! || a.time - b.time)[0];
  if (workerPeak) add("aftermath", "workers", `Your sampled worker count peaked at ${workerPeak.food_workers} at ${clock(workerPeak.time)}`, workerPeak.time, "worker samples");
  if (story.topLeak) add("aftermath", "lesson", `The highest-ranked priced macro leak was ${story.topLeak.name}. ${story.topLeak.detail}`, story.topLeak.time ?? length ?? 0, "macro leak rules");
  const blocks = (breakdown?.raw?.supply_block_windows ?? []).filter(row => nonnegative(row.start) && nonnegative(row.end) && row.end >= row.start && row.end <= 360);
  if (blocks.length) {
    const seconds = blocks.reduce((sum, row) => sum + (nonnegative(row.blocked_sec) ? Math.min(row.end - row.start, row.blocked_sec) : row.end - row.start), 0);
    add("aftermath", "early-blocks", `${blocks.length} complete supply-block ${blocks.length === 1 ? "window" : "windows"} before 6:00 contained ${Math.round(seconds)} counted blocked seconds`, blocks[0].start, "supply block windows");
  }
  const destroyed = (rows: MacroBreakdownData["production_buildings"]) => rows?.length && rows.every(row => row.destroyed === true && nonnegative(row.died_time));
  if (destroyed(breakdown?.production_buildings)) add("aftermath", "own-structures", "All your recorded production structures were destroyed", Math.max(...breakdown!.production_buildings!.map(row => row.died_time)), "production building lifetimes");
  if (destroyed(breakdown?.opp_production_buildings)) add("aftermath", "opp-structures", "All your opponent's recorded production structures were destroyed", Math.max(...breakdown!.opp_production_buildings!.map(row => row.died_time)), "production building lifetimes");
  // A result alone says nothing about GG or surrender. Those end conditions
  // are omitted because the game page does not currently carry chat events.
  const moments: SnapshotMoment[] = [];
  const moment = (id: string, time: number, caption: string, minimum = false) => {
    if (!nonnegative(time) || moments.some(row => Math.abs(row.time - time) < (minimum ? .001 : 5))) return;
    const marker = playback?.battles?.filter(row => Math.abs(row.t - time) <= 10).sort((a, b) => Math.abs(a.t - time) - Math.abs(b.t - time))[0];
    moments.push({ id, time, caption, ...(marker && finite(marker.x) && finite(marker.y) ? { point: { x: marker.x, y: marker.y } } : {}) });
  };
  if (fights[0]) moment("first-clash", fights[0].start, fights[0].estimated ? "First estimated fight window" : "First recorded casualty cluster");
  if (largest) moment("largest-swing", largest.time, "Largest sampled lead swing");
  if (biggestFight) moment("largest-fight", biggestFight.start, "Largest priced casualty cluster");
  if (length !== null) { if (!moments.length) moment("middle", length / 2, "Mid-game context"); moment("end", length, "End of the replay"); }
  if (length !== null && length > 0 && moments.length < 2) moment("opening", 0, "Opening context", true);
  const date = typeof game.date === "string" && Number.isFinite(Date.parse(game.date)) ? new Date(game.date).toISOString().slice(0, 10) : null;
  return { gameId: game.gameId, map, date, length, entries, beats, moments: moments.slice(0, 4), story, shape: comeback ? "comeback" : length !== null && length <= 300 ? "short" : story.turningPoints.length ? "swings" : "steady" };
}
