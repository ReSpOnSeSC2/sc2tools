import { currentMapPoolKey } from "./currentMapPool";
import type { PlayersResult, ReplayPlayer } from "./instant/types";
import { roomDigest, type ReportReplay, type Seat } from "./matchRoom";

type Player = Pick<ReplayPlayer, "pid" | "name" | "result"> & { digest: string };
type Header = Extract<PlayersResult, { ok: true }>;
export type MatchReplay = {
  mapKey: string; endedAt: number; durationSec: number; players: [Player, Player];
};

const TOON = /^\d+-s2-\d+-\d+$/iu;
const UTC_END_TIME = /(?:Z|[+-]\d{2}:\d{2})$/u;
const MAX_DURATION_SECONDS = 24 * 60 * 60;

export async function readMatchReplay(file: File, roomId: string, signal: AbortSignal): Promise<MatchReplay> {
  const { isReplayFileName, makeIntakeFile, MAX_REPLAY_BYTES } = await import("./instant/fileIntake");
  if (!isReplayFileName(file.name) || file.size === 0 || file.size > MAX_REPLAY_BYTES) {
    throw new MatchReplayError("Choose one .SC2Replay file up to 32 MB.");
  }
  const { createEngineClient } = await import("./instant/engineClient");
  signal.throwIfAborted();
  const engine = createEngineClient({ refreshPolicy: false });
  try {
    // A neutral path keeps the local file name out of worker errors and progress events.
    const intake = makeIntakeFile(file, "picker", "match.SC2Replay");
    const [result] = await engine.listPlayers([{ ...intake, name: "match.SC2Replay" }], { signal });
    return await prepareMatchReplay(result, roomId);
  } finally {
    engine.dispose();
  }
}

class MatchReplayError extends Error {}

export function matchReplayErrorText(error: unknown) {
  if (error instanceof MatchReplayError) return error.message;
  return "This replay could not be read. Choose it again or enter the score manually.";
}

function validPlayers(players: ReplayPlayer[]) {
  if (players.length !== 2) return false;
  const [a, b] = players;
  const outcomes = new Set([a.result, b.result]);
  return a.pid !== b.pid && outcomes.has("Win") && outcomes.has("Loss");
}

async function preparePlayer(player: ReplayPlayer, roomId: string): Promise<Player> {
  if (!player.toon || !TOON.test(player.toon)) {
    throw new MatchReplayError("Both players need a replay with a StarCraft II account identifier. Use manual scoring for this game.");
  }
  const digest = await roomDigest(JSON.stringify(["match-room/toon/v1", roomId, player.toon.toLowerCase()]));
  return { pid: player.pid, name: player.name, result: player.result, digest };
}

function replayGame({ map, date, durationSec }: Header): Omit<MatchReplay, "players"> {
  const mapKey = currentMapPoolKey(map);
  const endedAt = date && UTC_END_TIME.test(date) ? Date.parse(date) : NaN;
  if (!mapKey || mapKey.length > 128 || !Number.isSafeInteger(endedAt) || endedAt <= 0
    || !Number.isSafeInteger(durationSec) || durationSec <= 0 || durationSec > MAX_DURATION_SECONDS) {
    throw new MatchReplayError("This replay is missing the map, end time, or duration needed to report it.");
  }
  return { mapKey, endedAt, durationSec };
}

export async function prepareMatchReplay(result: PlayersResult | undefined, roomId: string): Promise<MatchReplay> {
  if (!result?.ok) throw new MatchReplayError("This replay could not be read. Choose it again or enter the score manually.");
  const { matchFormat, playerCount, isAiGame, players } = result;
  if (matchFormat !== "1v1" || playerCount !== 2 || isAiGame || !validPlayers(players)) {
    throw new MatchReplayError("Choose a finished one-on-one replay between two human players.");
  }
  const game = replayGame(result);
  const [a, b] = await Promise.all([preparePlayer(players[0], roomId), preparePlayer(players[1], roomId)]);
  if (a.digest === b.digest) throw new MatchReplayError("Choose a replay with two different StarCraft II accounts.");
  return { ...game, players: [a, b] };
}

export async function replayAction(replay: MatchReplay, seat: Seat, index: 0 | 1): Promise<ReportReplay> {
  const { mapKey, endedAt, durationSec, players } = replay;
  const mine = players[index];
  const opponent = players[index === 0 ? 1 : 0];
  const other = seat === "a" ? "b" : "a";
  const toonDigests = { a: seat === "a" ? mine.digest : opponent.digest,
    b: seat === "b" ? mine.digest : opponent.digest };
  const receipt = await roomDigest(JSON.stringify(["match-room/replay/v1", mapKey, endedAt, durationSec,
    ...Object.values(toonDigests).sort()]));
  return { type: "report_replay", mapKey, endedAt, durationSec, receipt, toonDigests,
    winnerSeat: mine.result === "Win" ? seat : other };
}
