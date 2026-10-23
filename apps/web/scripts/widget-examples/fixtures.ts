import type { LiveGameEnvelope, LiveGamePayload } from "../../components/overlay/types";
import type { ChatMessage } from "../../lib/multichat/types";
import { DEFAULT_BUILD_PROFILE, DEFAULT_STUDIO_STATE } from "fixture-original:studio";
import { EMPTY_ENGAGEMENT } from "fixture-original:engagement";
import { assignGhostTarget, emptyGhostBuildConfig, encodeGhostBuildConfig, GHOST_BUILD_VERSION } from "../../lib/ghostBuild";

export const NOW = 1_800_000_000_000;
export const LIVE: LiveGamePayload = {
  isTest: true, testNonce: "learning-example", myRace: "Protoss", oppRace: "Zerg",
  oppName: "TestOpponent", map: "Goldenaura LE", matchup: "PvZ", result: "win", durationSec: 612,
  oppMmr: 4250, myMmr: 4310, mmrDelta: 22, headToHead: { wins: 4, losses: 2 },
  streak: { kind: "win", count: 3 }, cheeseProbability: 0.65, cheeseHistory: { samples: 12, of: 20 },
  predictedStrategies: [{ name: "Pool first", weight: 0.45 }, { name: "Hatch first", weight: 0.35 }],
  topBuilds: [{ name: "P - Stargate", total: 14, winRate: 0.71 }, { name: "P - 4 Gate", total: 9, winRate: 0.55 }],
  bestAnswer: { build: "P - Stargate", winRate: 0.78, total: 7 },
  favOpening: { name: "Pool first", share: 0.55, samples: 11, of: 20 },
  scouting: [{ label: "Pool first", tellAt: 90, confidence: 0.55 }, { label: "Hatch first", tellAt: 75, confidence: 0.35 }],
  session: { wins: 4, losses: 2, games: 6, mmrStart: 4280, mmrCurrent: 4314, region: "NA", streak: { kind: "win", count: 3 } },
  rank: { league: "Diamond", tier: 1, mmr: 4310 },
  meta: { matchup: "PvZ", topBuilds: [{ name: "Pool first", share: 0.55 }, { name: "Hatch first", share: 0.35 }] },
  rival: { name: "TestOpponent", headToHead: { wins: 4, losses: 2 }, note: "Frequent opponent" },
  rematch: { isRematch: true, lastResult: "win" },
  recentGames: [
    { result: "Win", lengthText: "10:12", map: "Goldenaura LE", myBuild: "P - Stargate", oppBuild: "Z - Roach timing", oppRace: "Zerg" },
    { result: "Loss", lengthText: "3:47", map: "10000 Feet LE", myBuild: "P - Gateway expand", oppBuild: "Z - 12 Pool", oppRace: "Zerg" },
    { result: "Win", lengthText: "11:00", map: "Ruby Rock LE", myBuild: "P - Stargate", oppBuild: "Z - Hatch first", oppRace: "Zerg" },
  ],
};
export const LIVE_GAME: LiveGameEnvelope = {
  type: "liveGameState", phase: "match_in_progress", capturedAt: NOW / 1000,
  gameKey: "learning-example", displayTime: 95,
  user: { name: "Streamer", race: "Protoss" }, opponent: { name: "TestOpponent", race: "Zerg" },
  players: [
    { name: "Streamer", type: "user", race: "Protoss", result: "Undecided" },
    { name: "TestOpponent", type: "user", race: "Zerg", result: "Undecided" },
  ],
};
export const GHOST = encodeGhostBuildConfig(assignGhostTarget(emptyGhostBuildConfig(), "PvZ", {
  v: GHOST_BUILD_VERSION, name: "PvZ Gateway expand", steps: [
    { supply: 14, t: 17, name: "Pylon" }, { supply: 16, t: 42, name: "Gateway" },
    { supply: 17, t: 48, name: "Assimilator" }, { supply: 20, t: 85, name: "Nexus" },
    { supply: 20, t: 95, name: "CyberneticsCore" }, { supply: 22, t: 110, name: "Pylon" },
    { supply: 23, t: 123, name: "Adept" },
  ],
}));
export const STUDIO = {
  ...DEFAULT_STUDIO_STATE,
  highlight: { platform: "twitch", user: "MacroFan", text: "That hold at the third was incredible!", atMs: NOW },
  poll: { question: "Which matchup next?", options: ["PvT", "PvZ", "PvP"], startedAtMs: NOW - 60_000, status: "open" },
  goals: [{ label: "Tonight's wins", current: 4, target: 10 }, { label: "Community goal", current: 84, target: 100 }],
  timer: { label: "Back in a few", endsAt: NOW + 200_000, setAtMs: NOW },
  scene: { mode: "starting", message: "Ranked ladder night · grab a drink and settle in", countdownEndsAt: NOW + 299_000, setAtMs: NOW },
  buildProfile: { ...DEFAULT_BUILD_PROFILE, title: "PvZ Stargate opener", visible: true, ratings: { aggressiveness: 3, defensiveness: 4, executionDifficulty: 3, popularity: 4, micro: 2 } },
  loaded: true, snapshotReady: true,
};
export const ENGAGEMENT = {
  ...EMPTY_ENGAGEMENT,
  wall: [{ user: "MacroFan", platform: "twitch", xp: 840, level: 8, rank: "High Templar" }, { user: "WarpIn", platform: "kick", xp: 620, level: 6, rank: "Stalker" }, { user: "ProbeScout", platform: "youtube", xp: 420, level: 4, rank: "Zealot" }],
  oracles: [{ user: "MacroFan", platform: "twitch", score: 80, correct: 8, total: 10 }],
  prediction: { gameKey: "learning-example", opponent: "TestOpponent", tally: { win: 14, loss: 6, total: 20 }, locksAtMs: NOW + 40_000 },
};
export const MESSAGES: ChatMessage[] = [
  { platform: "twitch", id: "example-1", user: "MacroFan", text: "That hold at the third was incredible!", badges: ["vip"], color: "#b392f0", atMs: NOW - 4_000 },
  { platform: "kick", id: "example-2", user: "WarpIn", text: "GG! Stargate value ✨", badges: [], color: "#75d980", atMs: NOW - 3_000 },
  { platform: "youtube", id: "example-3", user: "ProbeScout", text: "What are we practicing next?", badges: ["member"], color: "#f1ae6a", atMs: NOW - 2_000 },
  { platform: "tiktok", id: "example-4", user: "LadderTime", text: "One more game! 💙", badges: [], color: "#63c9e8", atMs: NOW - 1_000 },
];
