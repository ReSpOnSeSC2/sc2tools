import { readStream, type LiveStream, type LiveStreamsSnapshot, type PlatformState } from "@/lib/live/streams";

/** Why Start raid is not available; the server's own words for it. */
export type RaidBlocker = "server_not_enabled" | "connect_twitch" | "raid_permission_required" | "switch_off";
export type RaidState = "pending" | "queued" | "canceled" | "closed" | "failed" | "unconfirmed" | "received";
export type RaidRelation = "raided" | "raided_by";

export type RaidCandidate = LiveStream & { relation: RaidRelation | null; small: boolean; raidable: boolean };
export type RaidEntry = { id: string; dir: "out" | "in"; channel: string; viewers: number; state: RaidState; at: number };
export type RaidView = {
  reason: RaidBlocker | null;
  platforms: LiveStreamsSnapshot["platforms"];
  candidates: RaidCandidate[];
  pending: { id: string; channel: string; at: number } | null;
  history: RaidEntry[];
};
/** What the Settings page shows: the gates, the permission and the streamer's switch. */
export type RaidSettingsView = { serverEnabled: boolean; enabled: boolean; connected: boolean; permission: boolean; reason: RaidBlocker | null };
export type RaidResult = { state: "queued" | "canceled"; channel: string };

/** Twitch counts down 90 seconds, and the server keeps a raid cancellable for three minutes. */
export const RAID_WINDOW_MS = 3 * 60_000;

const BLOCKERS: readonly string[] = ["server_not_enabled", "connect_twitch", "raid_permission_required", "switch_off"];
const STATES: readonly string[] = ["pending", "queued", "canceled", "closed", "failed", "unconfirmed", "received"];
type Row = Record<string, unknown>;
const isRow = (value: unknown): value is Row => typeof value === "object" && value !== null && !Array.isArray(value);
const PLATFORM_STATES: readonly string[] = ["ok", "stale", "error", "off"];
const platformState = (value: unknown): PlatformState => (PLATFORM_STATES.includes(String(value)) ? (value as PlatformState) : "off");
const blocker = (value: unknown): RaidBlocker | null => (typeof value === "string" && BLOCKERS.includes(value) ? (value as RaidBlocker) : null);

function readCandidate(value: unknown): RaidCandidate | null {
  const stream = readStream(value);
  if (!stream || !isRow(value)) return null;
  const relation = value.relation === "raided" || value.relation === "raided_by" ? value.relation : null;
  return { ...stream, relation, small: value.small === true, raidable: value.raidable === true };
}

function readEntry(value: unknown): RaidEntry | null {
  if (!isRow(value) || typeof value.id !== "string" || typeof value.channel !== "string" || !STATES.includes(String(value.state))) return null;
  const at = Number(value.at);
  if (!Number.isFinite(at)) return null;
  return { id: value.id, dir: value.dir === "in" ? "in" : "out", channel: value.channel, viewers: Math.max(0, Math.trunc(Number(value.viewers)) || 0),
    state: value.state as RaidState, at };
}

function readList<T>(value: unknown, read: (item: unknown) => T | null): T[] {
  return Array.isArray(value) ? value.map(read).filter((item): item is T => item !== null) : [];
}

/** Validates the Dock answer; a shape it does not recognise is not shown. */
export function readRaidView(value: unknown): RaidView | null {
  if (!isRow(value) || !isRow(value.platforms)) return null;
  const pending = isRow(value.pending) && typeof value.pending.id === "string" && typeof value.pending.channel === "string" && Number.isFinite(Number(value.pending.at))
    ? { id: value.pending.id, channel: value.pending.channel, at: Number(value.pending.at) } : null;
  return {
    reason: blocker(value.reason),
    platforms: { twitch: platformState(value.platforms.twitch), kick: platformState(value.platforms.kick) },
    candidates: readList(value.candidates, readCandidate),
    pending,
    history: readList(value.history, readEntry),
  };
}

export function readRaidSettings(value: unknown): RaidSettingsView | null {
  if (!isRow(value)) return null;
  return { serverEnabled: value.serverEnabled === true, enabled: value.enabled === true, connected: value.connected === true,
    permission: value.permission === true, reason: blocker(value.reason) };
}

export function readRaidResult(value: unknown): RaidResult | null {
  if (!isRow(value) || !isRow(value.result)) return null;
  const { state, channel } = value.result;
  return (state === "queued" || state === "canceled") && typeof channel === "string" ? { state, channel } : null;
}

export const BLOCKER_TEXT: Record<RaidBlocker, string> = {
  server_not_enabled: "Raids are not turned on for this server yet. The list still works.",
  connect_twitch: "Connect Twitch in Settings to start raids from here.",
  raid_permission_required: "Allow raids in Settings to start one from here.",
  switch_off: "Raids are switched off. Turn them on in Settings.",
};

export const RAID_STATE_LABELS: Record<RaidState, string> = {
  pending: "Waiting for Twitch", queued: "Queued", canceled: "Cancelled", closed: "No raid left to cancel",
  failed: "Refused", unconfirmed: "Not confirmed", received: "Received",
};

export const RELATION_LABELS: Record<RaidRelation, string> = { raided: "You raided them", raided_by: "They raided you" };

/** The line shown in place once Twitch has answered. */
export function raidResultMessage(result: RaidResult): string {
  const target = result.channel ? `Raid to ${result.channel}` : "Raid";
  return result.state === "queued"
    ? `${target} queued. Twitch counts down 90 seconds, then sends your viewers unless you cancel.`
    : `${target} cancelled. Twitch confirmed it.`;
}
