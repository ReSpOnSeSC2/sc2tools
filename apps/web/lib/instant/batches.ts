/**
 * Upload batch construction for browser ingest (`POST /v1/games`).
 *
 * Game JSON is produced by Python (`compact_json_bytes`, ASCII-only) and
 * is never re-serialised in JavaScript: `JSON.stringify` differs on
 * number formatting, key order and escaping, which would change bytes
 * and break the byte budgets. Batches are built by string concatenation
 * exactly like the agent's `{"games":[…]}` body.
 *
 * Browser batches stay under 4.5 MiB (the server caps bodies at 5 MiB
 * and must receive them within 45 s over a home uplink) and 50 games.
 *
 * Example:
 *   const tagged = games.map((g) => ({ ...g, json: tagBrowserGame(g.json, "1.6.3") }));
 *   const { batches, oversized } = buildUploadBatches(tagged);
 */
import type { UploadableGame } from "./types";

/** Server cap `REPLAY_INGEST_MAX_GAMES`. */
export const BROWSER_BATCH_MAX_GAMES = 50;
/** Soft body budget for browser batches (4.5 MiB). */
export const BROWSER_BATCH_MAX_BYTES = 4_718_592;
/** Hard server body cap (5 MiB); a body above this is never sent. */
export const API_BODY_MAX_BYTES = 5_242_880;

const BODY_PREFIX = '{"games":[';
const BODY_SUFFIX = "]}";
const SEPARATOR_BYTES = 1;
/** `{"games":[` + `]}`. */
const BODY_OVERHEAD_BYTES = BODY_PREFIX.length + BODY_SUFFIX.length;
/**
 * Same rule the API schema applies to `engineVersion`
 * (`INGEST_PROVENANCE.ENGINE_VERSION_PATTERN`, ≤ 40 chars): semver with
 * optional pre-release/build parts. It also guarantees the splice below
 * never needs JSON escaping.
 */
const ENGINE_VERSION_RE =
  /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const ENGINE_VERSION_MAX_LENGTH = 40;
const PROVENANCE_KEY_RE = /"(?:ingestSource|engineVersion)":/;

export interface BatchLimits {
  maxGames: number;
  maxBytes: number;
  hardMaxBytes: number;
}

export const DEFAULT_BATCH_LIMITS: BatchLimits = {
  maxGames: BROWSER_BATCH_MAX_GAMES,
  maxBytes: BROWSER_BATCH_MAX_BYTES,
  hardMaxBytes: API_BODY_MAX_BYTES,
};

export interface UploadBatch {
  gameIds: string[];
  /** Exact request body. */
  body: string;
  /** UTF-8 byte length of `body`. */
  bytes: number;
}

export interface BatchPlan {
  batches: UploadBatch[];
  /** Games whose singleton body exceeds the hard cap (never sent). */
  oversized: string[];
}

/** The game JSON could not be tagged (not a JSON object or already tagged). */
export class BrowserGameTagError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BrowserGameTagError";
  }
}

const encoder = new TextEncoder();

/**
 * UTF-8 byte length (Python's JSON is ASCII, but be exact regardless).
 *
 * Example:
 *   utf8Bytes("Ω"); // -> 2
 */
export function utf8Bytes(text: string): number {
  return encoder.encode(text).byteLength;
}

/**
 * Splice browser provenance into one game's compact JSON, right after
 * the opening brace, without re-serialising anything else.
 *
 * Example:
 *   tagBrowserGame('{"gameId":"a"}', "1.6.3");
 *   // -> '{"ingestSource":"browser","engineVersion":"1.6.3","gameId":"a"}'
 */
export function tagBrowserGame(json: string, engineVersion: string): string {
  if (engineVersion.length > ENGINE_VERSION_MAX_LENGTH || !ENGINE_VERSION_RE.test(engineVersion)) {
    throw new BrowserGameTagError("engineVersion is not a semver version string");
  }
  if (!json.startsWith("{") || !json.endsWith("}")) {
    throw new BrowserGameTagError("game JSON must be an object");
  }
  // Escaped quotes inside string values can never form `"key":`, so this
  // only matches real keys. Python never emits these keys.
  if (PROVENANCE_KEY_RE.test(json)) {
    throw new BrowserGameTagError("game JSON is already tagged");
  }
  const rest = json.slice(1);
  const separator = rest.trimStart().startsWith("}") ? "" : ",";
  const tags = `"ingestSource":"browser","engineVersion":"${engineVersion}"`;
  return `{${tags}${separator}${rest}`;
}

interface OpenBatch {
  gameIds: string[];
  parts: string[];
  bytes: number;
}

function emptyBatch(): OpenBatch {
  return { gameIds: [], parts: [], bytes: BODY_OVERHEAD_BYTES };
}

function closeBatch(open: OpenBatch): UploadBatch {
  return {
    gameIds: open.gameIds,
    body: BODY_PREFIX + open.parts.join(",") + BODY_SUFFIX,
    bytes: open.bytes,
  };
}

function addToBatch(open: OpenBatch, game: UploadableGame, gameBytes: number): void {
  if (open.parts.length > 0) open.bytes += SEPARATOR_BYTES;
  open.gameIds.push(game.gameId);
  open.parts.push(game.json);
  open.bytes += gameBytes;
}

/**
 * Greedy, order-preserving batching under the game-count and byte
 * budgets. A single game whose body is between the soft and hard caps
 * travels alone; one above the hard cap is reported as oversized.
 *
 * Example:
 *   buildUploadBatches(games).batches.map((b) => b.gameIds.length); // -> [50, 50, 12]
 */
export function buildUploadBatches(
  games: ReadonlyArray<UploadableGame>,
  limits: BatchLimits = DEFAULT_BATCH_LIMITS,
): BatchPlan {
  const batches: UploadBatch[] = [];
  const oversized: string[] = [];
  let open = emptyBatch();
  const flush = () => {
    if (open.parts.length > 0) batches.push(closeBatch(open));
    open = emptyBatch();
  };
  for (const game of games) {
    const gameBytes = utf8Bytes(game.json);
    const singletonBytes = BODY_OVERHEAD_BYTES + gameBytes;
    if (singletonBytes > limits.hardMaxBytes) {
      oversized.push(game.gameId);
      continue;
    }
    if (singletonBytes > limits.maxBytes) {
      flush();
      addToBatch(open, game, gameBytes);
      flush();
      continue;
    }
    const full = open.parts.length >= limits.maxGames;
    const tooBig = open.bytes + SEPARATOR_BYTES + gameBytes > limits.maxBytes;
    if (open.parts.length > 0 && (full || tooBig)) flush();
    addToBatch(open, game, gameBytes);
  }
  flush();
  return { batches, oversized };
}
