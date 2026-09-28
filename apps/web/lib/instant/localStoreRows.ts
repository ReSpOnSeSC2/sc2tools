/**
 * Row shapes and validators for the Instant Analysis IndexedDB store.
 *
 * Storage sits outside the type system (older app versions, another tab,
 * manual edits), so every row read back is narrowed here before use and
 * anything malformed is dropped rather than trusted. Pure functions only;
 * `localStore.ts` does the I/O.
 *
 * Example:
 *   const game = toStoredTryGame(await idbGet(db, "tryGames", id)); // StoredTryGame | null
 */
import { INSTANT_ENGINE_VERSION } from "./engineVersion";
import { isErrorKind, type LedgerEntry, type LedgerStatus } from "./ledger";

const DAY_MS = 24 * 60 * 60 * 1000;

/** /try games are kept on this device for this many days. */
export const TRY_TTL_DAYS = 7;
/** {@link TRY_TTL_DAYS} in milliseconds. */
export const TRY_TTL_MS = TRY_TTL_DAYS * DAY_MS;
/**
 * At most this many /try games are kept on a device: repeated "Analyze
 * more replays" runs drop the oldest-stored games instead of growing the
 * database without bound.
 */
export const MAX_STORED_TRY_GAMES = 100;

export interface TryGameInput {
  gameId: string;
  /** Compact payload JSON exactly as the engine produced it. */
  json: string;
  /** Replay date (RFC 3339). */
  date: string;
  /** Engine release that produced `json` (sent as the upload's `engineVersion`). */
  engineVersion: string;
}

export interface StoredTryGame extends TryGameInput {
  storedAt: number;
  expiresAt: number;
}

/** A Folder Sync auto-sync pause after the daily browser-upload cap. */
export interface IngestPause {
  userId: string;
  /** Epoch ms when uploads resume. */
  until: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * True for a finite number (not NaN or ±Infinity).
 *
 * Example:
 *   isFiniteNumber(3); // -> true
 */
export function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Narrow a stored /try game. Rows saved before games carried their engine
 * version get the current one (they are at most 7 days old).
 *
 * Example:
 *   toStoredTryGame({ gameId: "g", json: "{}", date: "2026-09-01", storedAt: 1, expiresAt: 2 })?.engineVersion;
 *   // -> INSTANT_ENGINE_VERSION
 */
export function toStoredTryGame(value: unknown): StoredTryGame | null {
  if (!isRecord(value)) return null;
  const { gameId, json, date, storedAt, expiresAt, engineVersion } = value;
  if (typeof gameId !== "string" || typeof json !== "string" || typeof date !== "string") {
    return null;
  }
  if (!isFiniteNumber(storedAt) || !isFiniteNumber(expiresAt)) return null;
  const version = typeof engineVersion === "string" && engineVersion ? engineVersion : INSTANT_ENGINE_VERSION;
  return { gameId, json, date, engineVersion: version, storedAt, expiresAt };
}

/**
 * Sort order for trimming: the most recently analysed games first, then
 * the newest replay date.
 *
 * Example:
 *   rows.sort(newestStoredFirst);
 */
export function newestStoredFirst(a: StoredTryGame, b: StoredTryGame): number {
  return b.storedAt - a.storedAt || b.date.localeCompare(a.date);
}

const LEDGER_STATUSES: ReadonlyArray<LedgerStatus> = ["uploaded", "skipped", "failed"];

function isLedgerStatus(value: unknown): value is LedgerStatus {
  return LEDGER_STATUSES.some((status) => status === value);
}

function toToons(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const toons = value.filter((toon): toon is string => typeof toon === "string" && toon.length > 0);
  return toons.length > 0 ? toons : null;
}

/** Optional fields: unknown kinds (a newer app version) and bad values are dropped. */
function withOptionalFields(entry: LedgerEntry, row: Record<string, unknown>): LedgerEntry {
  const { gameId, errorKind, attempts } = row;
  if (typeof gameId === "string") entry.gameId = gameId;
  if (typeof errorKind === "string" && isErrorKind(errorKind)) entry.errorKind = errorKind;
  if (isFiniteNumber(attempts) && Number.isInteger(attempts) && attempts > 0) entry.attempts = attempts;
  const toons = toToons(row.toons);
  if (toons) entry.toons = toons;
  return entry;
}

/**
 * Narrow a stored Folder Sync ledger row.
 *
 * Example:
 *   toLedgerEntry({ path: "a", size: 1, lastModified: 2, status: "failed", errorKind: "timeout", attempts: 2, updatedAt: 3 });
 */
export function toLedgerEntry(value: unknown): LedgerEntry | null {
  if (!isRecord(value)) return null;
  const { path, size, lastModified, status, updatedAt } = value;
  if (typeof path !== "string" || !isLedgerStatus(status)) return null;
  if (!isFiniteNumber(size) || !isFiniteNumber(lastModified) || !isFiniteNumber(updatedAt)) {
    return null;
  }
  return withOptionalFields({ path, size, lastModified, status, updatedAt }, value);
}

/**
 * Narrow a stored auto-sync pause.
 *
 * Example:
 *   toIngestPause({ userId: "user_1", until: 5 }); // -> { userId: "user_1", until: 5 }
 */
export function toIngestPause(value: unknown): IngestPause | null {
  if (!isRecord(value)) return null;
  const { userId, until } = value;
  return typeof userId === "string" && isFiniteNumber(until) ? { userId, until } : null;
}
