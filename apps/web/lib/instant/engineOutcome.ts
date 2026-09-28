/**
 * Turn the JSON envelopes returned by `sc2tools_agent.instant_analysis`
 * (through the worker glue) into the typed results of `types.ts`, and turn
 * unzipped archive entries into `IntakeFile`s.
 *
 * Python output is treated as untrusted data: every field is narrowed, and
 * a malformed envelope becomes a failure instead of a mistyped success.
 *
 * Example:
 *   toParseOutcome(JSON.parse(raw), { fileName: "a.SC2Replay", relativePath: "a.SC2Replay", ms: 640 });
 *   // -> { ok: true, gameId: "...", json: "{...}", ... }
 */
import { intakeKey } from "./fileIntake";
import { isErrorKind } from "./ledger";
import type {
  ErrorKind,
  FailedParse,
  IntakeFile,
  MatchFormat,
  ParseOutcome,
  PlayersResult,
  ReplayDigests,
  ReplayPlayer,
} from "./types";

type Json = Record<string, unknown>;

/** File identity + timing attached to every outcome. */
export interface OutcomeMeta {
  fileName: string;
  relativePath: string;
  ms: number;
}

const MATCH_FORMATS: readonly MatchFormat[] = ["1v1", "team", "ffa", "other"];
const PLAYER_RESULTS: ReadonlyArray<ReplayPlayer["result"]> = ["Win", "Loss", "Tie"];
const MALFORMED = "the engine returned a malformed result";
const ZIP_ENTRY_MIME = "application/octet-stream";

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function matchFormat(value: unknown): MatchFormat | null {
  return MATCH_FORMATS.find((format) => format === value) ?? null;
}

function errorKindOf(value: unknown, fallback: ErrorKind): ErrorKind {
  return typeof value === "string" && isErrorKind(value) ? value : fallback;
}

/**
 * A `FailedParse` for this file.
 *
 * Example:
 *   failedParse(meta, "timeout", "no answer within 60 s");
 */
export function failedParse(meta: OutcomeMeta, errorKind: ErrorKind, detail?: string): FailedParse {
  const failure: FailedParse = { ok: false, fileName: meta.fileName, relativePath: meta.relativePath, errorKind, ms: meta.ms };
  if (detail) failure.detail = detail;
  return failure;
}

/**
 * Narrow `{ok, sha256, md5, sizeBytes}` digests; undefined when malformed.
 *
 * Example:
 *   toDigests({ sha256: "ab", md5: "x==", sizeBytes: 3 }); // -> same object
 */
export function toDigests(value: unknown): ReplayDigests | undefined {
  if (!isRecord(value)) return undefined;
  const { sha256, md5, sizeBytes } = value;
  if (typeof sha256 !== "string" || typeof md5 !== "string" || typeof sizeBytes !== "number") return undefined;
  return { sha256, md5, sizeBytes };
}

/**
 * Map a `parse_replay_bytes` envelope (minus `payload`) to a `ParseOutcome`.
 *
 * Example:
 *   toParseOutcome({ ok: false, errorKind: "ai_game", detail: "..." }, meta).errorKind; // -> "ai_game"
 */
export function toParseOutcome(envelope: unknown, meta: OutcomeMeta, digests?: ReplayDigests): ParseOutcome {
  if (!isRecord(envelope)) return failedParse(meta, "analysis_failed", MALFORMED);
  if (envelope.ok !== true) {
    const detail = typeof envelope.detail === "string" ? envelope.detail : undefined;
    return failedParse(meta, errorKindOf(envelope.errorKind, "analysis_failed"), detail);
  }
  const { gameId, json, date } = envelope;
  if (typeof gameId !== "string" || typeof json !== "string" || typeof date !== "string") {
    return failedParse(meta, "analysis_failed", MALFORMED);
  }
  return {
    ok: true,
    fileName: meta.fileName,
    relativePath: meta.relativePath,
    gameId,
    json,
    date,
    myToonHandle: optionalString(envelope.myToonHandle),
    matchFormat: matchFormat(envelope.matchFormat),
    isResumedFromReplay: envelope.isResumedFromReplay === true,
    ms: meta.ms,
    ...(digests ? { digests } : {}),
  };
}

function toPlayer(value: unknown): ReplayPlayer | null {
  if (!isRecord(value) || typeof value.name !== "string" || typeof value.pid !== "number") return null;
  return {
    name: value.name,
    toon: optionalString(value.toon),
    race: typeof value.race === "string" ? value.race : "",
    result: PLAYER_RESULTS.find((result) => result === value.result) ?? null,
    pid: value.pid,
  };
}

/**
 * Map a `list_replay_players` envelope to a `PlayersResult`.
 *
 * Example:
 *   toPlayersResult({ ok: false, errorKind: "corrupt_file" }); // -> { ok: false, errorKind: "corrupt_file" }
 */
export function toPlayersResult(envelope: unknown): PlayersResult {
  if (!isRecord(envelope)) return { ok: false, errorKind: "parse_failed", detail: MALFORMED };
  if (envelope.ok !== true) {
    const failure: PlayersResult = { ok: false, errorKind: errorKindOf(envelope.errorKind, "parse_failed") };
    if (typeof envelope.detail === "string") failure.detail = envelope.detail;
    return failure;
  }
  const players = Array.isArray(envelope.players) ? envelope.players.map(toPlayer) : null;
  if (!players || players.some((player) => player === null)) {
    return { ok: false, errorKind: "parse_failed", detail: MALFORMED };
  }
  return {
    ok: true,
    players: players.filter((player): player is ReplayPlayer => player !== null),
    date: optionalString(envelope.date),
    map: optionalString(envelope.map),
    durationSec: typeof envelope.durationSec === "number" ? envelope.durationSec : 0,
    matchFormat: matchFormat(envelope.matchFormat),
    playerCount: typeof envelope.playerCount === "number" ? envelope.playerCount : players.length,
    isAiGame: envelope.isAiGame === true,
    toonFromPath: optionalString(envelope.toonFromPath),
  };
}

/**
 * Wrap one unzipped replay as an `IntakeFile`. The path keeps the archive's
 * own path as a prefix, so entries of different zips never collide and a
 * `<toon>` folder inside the archive still identifies the player.
 *
 * Example:
 *   zipEntryFile(zip, "Accounts/1/1-S2-1-1/Replays/a.SC2Replay", bytes).relativePath;
 *   // -> "replays.zip/Accounts/1/1-S2-1-1/Replays/a.SC2Replay"
 */
export function zipEntryFile(zip: IntakeFile, entryName: string, bytes: ArrayBuffer): IntakeFile {
  const relativePath = `${zip.relativePath}/${entryName}`;
  const name = entryName.split("/").pop() || entryName;
  return {
    key: intakeKey(relativePath, bytes.byteLength, zip.lastModified),
    name,
    relativePath,
    size: bytes.byteLength,
    lastModified: zip.lastModified,
    source: "zip",
    blob: new Blob([bytes], { type: ZIP_ENTRY_MIME }),
  };
}
