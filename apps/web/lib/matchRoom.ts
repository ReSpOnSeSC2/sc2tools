import type { MatchResultShareCard } from "./personalShareCards";
import { ROOM_PATH } from "./matchRoomRoute";

export const FORMATS = [1, 3, 5, 7] as const;
export const PRESETS = [
  { id: "standard", label: "Ban then pick", detail: "Alternate bans, then choose the map order. The last map is the decider." },
  { id: "pick-first", label: "Pick then ban", detail: "Choose the opening maps before banning down to the decider." },
  { id: "ban-only", label: "Bans only", detail: "Ban down to the series length. A draw orders the remaining maps." },
] as const;

export type Seat = "a" | "b";
export type Role = "host" | "watch" | Seat;
export type Format = typeof FORMATS[number];
export type Preset = typeof PRESETS[number]["id"];
export type RoomConfig = { format: Format; preset: Preset; maps: string[]; practice: boolean };
export type RoomInvite = { id: string; role: "watch" } | { id: string; role: Exclude<Role, "watch">; key: string };
type Turn = { seat: Seat; kind: "pick" | "ban" };
type Move = Turn & { map: number; automatic: boolean };
export type Room = {
  config: RoomConfig; rev: number; expiresAt: number; serverTime: number; phase: "lobby" | "veto" | "play" | "complete";
  names: Record<Seat, string>; ready: Record<Seat, boolean>; score: Record<Seat, number>;
  first: Seat; turn: Turn | null; deadline: number | null; moves: Move[]; order: number[]; winners: Seat[];
};
export type RoomAction =
  | { type: "name"; value: string; as: Seat }
  | { type: "ready"; value: boolean; as: Seat }
  | { type: "veto"; map: number; as: Seat }
  | { type: "score"; winner: Seat }
  | { type: "undo" };

export const SEATS = ["a", "b"] as const;
const ID = /^[A-Za-z0-9_-]{32}$/;
const SEAT_KEY = /^[0-9a-f]{64}$/;

export function seatLabel(seat: Seat) {
  return seat === "a" ? "Seat A" : "Seat B";
}

export function parseRoomInvite(hash: string): RoomInvite | null {
  if (hash.length > 160) return null;
  const params = new URLSearchParams(hash.replace(/^#/, ""));
  const id = params.get("r") ?? "";
  const role = params.get("seat");
  const key = params.get("key") ?? "";
  if (!ID.test(id)) return null;
  if (role === null && !key) return { id, role: "watch" };
  return parseWriteInvite(id, role, key);
}

function parseWriteInvite(id: string, role: string | null, key: string): RoomInvite | null {
  if (role === "host" && ID.test(key)) return { id, role, key };
  if (isSeat(role) && SEAT_KEY.test(key)) return { id, role, key };
  return null;
}

export function invitePath(invite: RoomInvite): string {
  const params = new URLSearchParams({ r: invite.id });
  if (invite.role !== "watch") {
    params.set("seat", invite.role);
    params.set("key", invite.key);
  }
  return ROOM_PATH + "#" + params.toString();
}

/** Derive the same seat key as the API so hosts can recover links after reload. */
export async function deriveSeatKey(hostKey: string, seat: Seat) {
  const input = new TextEncoder().encode("match-room/seat-" + seat + ":" + hostKey);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", input));
  return Array.from(digest, byte => byte.toString(16).padStart(2, "0")).join("");
}

export function pollDelay(phase: Room["phase"] | undefined, hidden: boolean) {
  if (hidden || phase === "complete") return 30_000;
  return phase === "veto" ? 2_000 : 10_000;
}

export function resultText(room: Room, style: "discord" | "reddit") {
  const title = "StarCraft II best of " + room.config.format;
  const score = "Seat A " + room.score.a + "–" + room.score.b + " Seat B";
  const games = room.winners.map((seat, index) => "Game " + (index + 1) + " · " + seatLabel(seat)).join("\n");
  const format = style === "discord" ? "**" + title + "**" : "### " + title;
  return [format, score, games].filter(Boolean).join("\n\n");
}

export function matchResultCard(room: Room): MatchResultShareCard {
  return { kind: "match_result", path: "/match", title: "Match result",
    subtitle: "StarCraft II best of " + room.config.format,
    stats: SEATS.map(seat => ({ label: seatLabel(seat), value: String(room.score[seat]) })) };
}

export function isFormat(value: unknown): value is Format {
  return value === 1 || value === 3 || value === 5 || value === 7;
}

export function isPreset(value: unknown): value is Preset {
  return PRESETS.some(preset => preset.id === value);
}

function isSeat(value: unknown): value is Seat {
  return value === "a" || value === "b";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function seatPair<T>(value: unknown, guard: (entry: unknown) => entry is T): value is Record<Seat, T> {
  return isRecord(value) && guard(value.a) && guard(value.b);
}

function natural(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isString(value: unknown): value is string { return typeof value === "string"; }
function isBoolean(value: unknown): value is boolean { return typeof value === "boolean"; }
function isTurn(value: unknown): value is Turn {
  return isRecord(value) && isSeat(value.seat) && (value.kind === "pick" || value.kind === "ban");
}

function roomConfig(value: unknown): RoomConfig | null {
  if (!isRecord(value) || !isFormat(value.format) || !isPreset(value.preset) || !isBoolean(value.practice)) return null;
  const maps = value.maps;
  if (!Array.isArray(maps) || maps.length < value.format || maps.length > 20 || !maps.every(isString)) return null;
  return { format: value.format, preset: value.preset, maps, practice: value.practice };
}

function isPhase(value: unknown): value is Room["phase"] {
  return value === "lobby" || value === "veto" || value === "play" || value === "complete";
}

function validTiming(value: Record<string, unknown>) {
  return natural(value.rev) && natural(value.expiresAt) && natural(value.serverTime)
    && (value.deadline === null || natural(value.deadline));
}

function validTurn(phase: Room["phase"], turn: unknown, deadline: unknown) {
  return phase === "veto" ? isTurn(turn) && natural(deadline) : turn === null && deadline === null;
}

function roomProgress(value: Record<string, unknown>, mapCount: number) {
  const { phase, turn, deadline, moves, order, winners } = value;
  const isMap = (map: unknown): map is number => natural(map) && map < mapCount;
  const isMove = (move: unknown): move is Move => isRecord(move) && isMap(move.map) && isBoolean(move.automatic) && isTurn(move);
  if (!isPhase(phase) || !Array.isArray(moves) || !moves.every(isMove)
    || !Array.isArray(order) || !order.every(isMap) || !Array.isArray(winners) || !winners.every(isSeat)) return null;
  if (!validTurn(phase, turn, deadline)) return null;
  return { phase, turn: isTurn(turn) ? turn : null, moves, order, winners };
}

export function parseRoom(value: unknown): Room | null {
  if (!isRecord(value) || !validTiming(value)) return null;
  const { names, ready, score, first } = value;
  if (!seatPair(names, isString) || !seatPair(ready, isBoolean) || !seatPair(score, natural) || !isSeat(first)) return null;
  const config = roomConfig(value.config);
  if (!config) return null;
  const progress = roomProgress(value, config.maps.length);
  if (!progress) return null;
  return { config, names, ready, score, first, ...progress, rev: Number(value.rev),
    expiresAt: Number(value.expiresAt), serverTime: Number(value.serverTime),
    deadline: value.deadline === null ? null : Number(value.deadline) };
}

export function parseCreatedRoom(value: unknown): RoomInvite | null {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.hostKey !== "string") return null;
  return parseRoomInvite(invitePath({ id: value.id, role: "host", key: value.hostKey }).slice(ROOM_PATH.length));
}
