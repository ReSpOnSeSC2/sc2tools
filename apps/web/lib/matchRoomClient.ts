import { API_BASE } from "@/lib/clientApi";
import { parseCreatedRoom, parseRoom, type RoomAction, type RoomConfig, type RoomInvite } from "./matchRoom";

const PATH = API_BASE + "/v1/match-rooms";

export class RoomRequestError extends Error {
  constructor(readonly status: number, readonly retryMs = 0) {
    super("Match room request failed");
  }
}

async function request(url: string, init: RequestInit) {
  const deadline = AbortSignal.timeout(12_000);
  const signal = init.signal ? AbortSignal.any([init.signal, deadline]) : deadline;
  const response = await fetch(url, { ...init, signal, cache: "no-store", credentials: "omit", referrerPolicy: "no-referrer" });
  if (!response.ok) {
    const delay = Number(response.headers.get("Retry-After"));
    const retryMs = Number.isFinite(delay) ? Math.max(0, Math.min(delay * 1000, 3_600_000)) : 0;
    throw new RoomRequestError(response.status, retryMs);
  }
  return response.status === 204 ? null : response.json() as Promise<unknown>;
}

function jsonRequest(method: "POST" | "DELETE", body: unknown, signal: AbortSignal): RequestInit {
  return { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal };
}

export async function createRoom(config: RoomConfig, signal: AbortSignal) {
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

export function roomErrorText(error: unknown, writing: boolean) {
  if (error instanceof RoomRequestError) {
    if (error.status === 429) return "Too many requests. Wait a moment and try again.";
    if (error.status === 409) return "The room changed. Check the current turn or score, then try again.";
    if (error.status === 403) return "This link cannot make that change. Open the original host or seat link.";
    if (error.status === 400) return writing ? "Check the name or map list and try again." : "This room could not be read.";
    if (error.status === 503) return "Match Rooms are busy. Try again in a moment.";
  }
  return writing ? "The change could not be saved. Check the room before trying again." : "The room could not be reached.";
}
