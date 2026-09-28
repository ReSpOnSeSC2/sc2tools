/**
 * Typed guards for the `POST /v1/games` 202 response
 * `{ accepted: [{gameId, created, quarantined?, replayArchive?}],
 *    rejected: [{gameId|null, errors, retryable?}] }`.
 *
 * The body is narrowed from `unknown`; malformed items are dropped so a
 * partially odd response can never crash the uploader (a game that
 * vanishes from both lists is requeued by the caller).
 *
 * Example:
 *   const parsed = parseIngestResponse(await res.json());
 *   if (!parsed) retry();
 */

/** Server's proof that the original replay is already archived. */
export interface ReplayArchiveMarker {
  available: boolean;
  sizeBytes?: number;
  sha256?: string;
  storedAt?: string;
}

export interface AcceptedGame {
  gameId: string;
  created: boolean;
  quarantined?: boolean;
  replayArchive?: ReplayArchiveMarker;
}

export interface RejectedItem {
  gameId: string | null;
  errors: string[];
  retryable: boolean;
}

export interface IngestResponse {
  accepted: AcceptedGame[];
  rejected: RejectedItem[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Narrow a `replayArchive` marker (null when malformed).
 *
 * Example:
 *   parseReplayArchive({ available: true, sizeBytes: 10, sha256: "ab" });
 */
export function parseReplayArchive(value: unknown): ReplayArchiveMarker | null {
  if (!isRecord(value) || typeof value.available !== "boolean") return null;
  const marker: ReplayArchiveMarker = { available: value.available };
  if (typeof value.sizeBytes === "number" && Number.isFinite(value.sizeBytes)) {
    marker.sizeBytes = value.sizeBytes;
  }
  if (typeof value.sha256 === "string") marker.sha256 = value.sha256;
  if (typeof value.storedAt === "string") marker.storedAt = value.storedAt;
  return marker;
}

function parseAccepted(value: unknown): AcceptedGame | null {
  if (!isRecord(value) || typeof value.gameId !== "string") return null;
  const item: AcceptedGame = { gameId: value.gameId, created: value.created === true };
  if (value.quarantined === true) item.quarantined = true;
  const archive = parseReplayArchive(value.replayArchive);
  if (archive) item.replayArchive = archive;
  return item;
}

function parseRejected(value: unknown): RejectedItem | null {
  if (!isRecord(value)) return null;
  const gameId = typeof value.gameId === "string" ? value.gameId : null;
  const errors = Array.isArray(value.errors)
    ? value.errors.filter((error): error is string => typeof error === "string")
    : [];
  return { gameId, errors, retryable: value.retryable === true };
}

function compact<T>(items: ReadonlyArray<T | null>): T[] {
  return items.filter((item): item is T => item !== null);
}

/**
 * Narrow an ingest response body; null unless both lists are arrays.
 *
 * Example:
 *   parseIngestResponse({ accepted: [], rejected: [] }); // -> { accepted: [], rejected: [] }
 */
export function parseIngestResponse(value: unknown): IngestResponse | null {
  if (!isRecord(value) || !Array.isArray(value.accepted) || !Array.isArray(value.rejected)) {
    return null;
  }
  return {
    accepted: compact(value.accepted.map(parseAccepted)),
    rejected: compact(value.rejected.map(parseRejected)),
  };
}
