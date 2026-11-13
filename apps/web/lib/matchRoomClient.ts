import { API_BASE } from "@/lib/clientApi";
import { parseCreatedRoom, parseRoom, type RoomAction, type RoomConfig, type RoomInvite } from "./matchRoom";

const PATH = API_BASE + "/v1/match-rooms";
const READ_ERROR_CODES = new Set([400, 404, 409]);
const REPLAY_ERRORS = {
  invalid_match_replay: "This replay report could not be read. Choose the replay again.",
  replay_scoring_unavailable: "This room can only score games manually.",
  replay_seats_changed: "The selected players do not match the room seats. Check which player you chose.",
  replay_result_conflict: "This report disagrees with the recorded winner. Check the score before trying again.",
  replay_map_mismatch: "This replay is not from the next unplayed map. Check the map order or use manual scoring.",
  replay_time_mismatch: "This replay must end after the veto and the previous game, and cannot be from the future.",
};
type RoomErrorCode = "match_room_missing" | "match_room_attempt_closed" | "match_room_attempt_mismatch" | keyof typeof REPLAY_ERRORS;

function isReplayError(code: unknown): code is keyof typeof REPLAY_ERRORS {
  return typeof code === "string" && Object.hasOwn(REPLAY_ERRORS, code);
}

export class RoomRequestError extends Error {
  constructor(readonly status: number, readonly retryMs = 0, readonly code?: RoomErrorCode) {
    super("Match room request failed");
  }

  get creationAttemptEnded() {
    return this.code === "match_room_attempt_closed" || this.code === "match_room_attempt_mismatch";
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? value as Record<string, unknown> : undefined;
}

async function knownErrorCode(response: Response): Promise<RoomErrorCode | undefined> {
  if (!READ_ERROR_CODES.has(response.status)) return;
  const body = record(await response.json().catch(() => null));
  const code = record(body?.error)?.code;
  if (response.status === 404) return code === "match_room_missing" ? code : undefined;
  if (isReplayError(code)) return code;
  if (code === "match_room_attempt_closed" || code === "match_room_attempt_mismatch") return code;
}

async function request(url: string, init: RequestInit) {
  const deadline = AbortSignal.timeout(12_000);
  const signal = init.signal ? AbortSignal.any([init.signal, deadline]) : deadline;
  const response = await fetch(url, { ...init, signal, cache: "no-store", credentials: "omit", referrerPolicy: "no-referrer" });
  if (!response.ok) {
    const delay = Number(response.headers.get("Retry-After"));
    const retryMs = Number.isFinite(delay) ? Math.max(0, Math.min(delay * 1000, 3_600_000)) : 0;
    throw new RoomRequestError(response.status, retryMs, await knownErrorCode(response));
  }
  return response.status === 204 ? null : response.json() as Promise<unknown>;
}

function jsonRequest(method: "POST" | "DELETE", body: unknown, signal: AbortSignal): RequestInit {
  return { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal };
}

export function newCreationAttempt() {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
}

export async function createRoom(config: RoomConfig & { attempt: string }, signal: AbortSignal) {
  const invite = parseCreatedRoom(await request(PATH, jsonRequest("POST", config, signal)));
  if (!invite) throw new RoomRequestError(502);
  return invite;
}

export async function readRoom(id: string, rev: number | undefined, signal: AbortSignal) {
  const payload = await request(PATH + "/" + id + (rev === undefined ? "" : "?rev=" + rev), { signal });
  if (payload === null && rev !== undefined) return null;
  const room = parseRoom(payload);
  if (!room) throw new RoomRequestError(502);
  return room;
}

export async function writeRoom(invite: Exclude<RoomInvite, { role: "watch" }>, rev: number, action: RoomAction, signal: AbortSignal) {
  const data = await request(PATH + "/" + invite.id + "/actions", jsonRequest("POST", { key: invite.key, rev, action }, signal));
  const room = parseRoom(data);
  if (!room) throw new RoomRequestError(502);
  return room;
}

export async function deleteRoom(invite: Exclude<RoomInvite, { role: "watch" }>, signal: AbortSignal) {
  await request(PATH + "/" + invite.id, jsonRequest("DELETE", { key: invite.key }, signal));
}

const INVALID_REQUEST = {
  create: "Check the series format and map list, then try again.",
  read: "This room could not be read.",
  write: "Check the name or selected move and try again.",
};
const REQUEST_FAILED = {
  create: "The room could not be created. Try again.",
  read: "The room could not be reached.",
  write: "The change could not be saved. Check the room before trying again.",
};

export function roomErrorText(error: unknown, action: keyof typeof REQUEST_FAILED) {
  if (error instanceof RoomRequestError) {
    if (error.creationAttemptEnded) return "This creation attempt has ended. Try creating the room again.";
    if (isReplayError(error.code)) return REPLAY_ERRORS[error.code];
    if (error.status === 429) return "Too many requests. Wait a moment and try again.";
    if (error.status === 409) return "The room changed. Check the current turn or score, then try again.";
    if (error.status === 403) return "This link cannot make that change. Open the original host or seat link.";
    if (error.status === 400) return INVALID_REQUEST[action];
    if (error.status === 503) return "Match Rooms are busy. Try again in a moment.";
  }
  return REQUEST_FAILED[action];
}
