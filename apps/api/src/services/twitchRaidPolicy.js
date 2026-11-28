"use strict";

/**
 * Pure rules for the raid finder: which live channels are offered and in what
 * order, how the streamer's own switch and raid history are shaped, and what a
 * Twitch refusal means in plain words. Nothing here touches a provider or the
 * database.
 */

const { clip } = require("./twitchAutomationPolicy");

/** A channel at or under this many viewers is "small" and is offered first. */
const SMALL_MAX_VIEWERS = 20;
const MAX_CANDIDATES = 40;
const HISTORY_LIMIT = 30;
/** Twitch counts down 90 seconds before a queued raid goes; the rest is slack. */
const RAID_WINDOW_MS = 2 * 60_000;
/** A receipt still "pending" this long after it was written never got an answer. */
const PENDING_GRACE_MS = 60_000;
const OUT_STATES = /** @type {const} */ (["pending", "queued", "canceled", "closed", "failed", "unconfirmed"]);

/** @typedef {import('./liveStreamProviders').LiveStream} LiveStream */
/** @typedef {"pending" | "queued" | "canceled" | "closed" | "failed" | "unconfirmed"} OutState */
/**
 * One raid the streamer sent ("out") or received ("in"). `viewers` is the
 * target's audience when sent, or the size of the raid when received.
 *
 * @typedef {{
 *   id: string,
 *   dir: "out" | "in",
 *   channel: string,
 *   viewers: number,
 *   state: OutState | "received",
 *   at: number,
 *   reason?: string,
 * }} RaidEntry
 */
/** @typedef {{ enabled: boolean }} RaidSettings */
/** @typedef {LiveStream & { relation: "raided" | "raided_by" | null, small: boolean, raidable: boolean }} RaidCandidate */

/** @param {unknown} value @returns {Record<string, unknown>} */
const object = value => (value && typeof value === "object" && !Array.isArray(value) ? /** @type {Record<string, unknown>} */ (value) : {});

/** @param {string} message @param {number} status @param {string} code */
const raidError = (message, status, code) => Object.assign(new Error(message), { status, code });

/** @param {unknown} raw @param {boolean} [strict] */
function raidSettings(raw, strict = false) {
  const source = object(raw);
  if (strict && (typeof source.enabled !== "boolean" || Object.keys(source).some(key => key !== "enabled"))) {
    throw raidError("Save the raid switch as on or off.", 400, "invalid_raid_settings");
  }
  return { enabled: source.enabled === true };
}

/** The key two spellings of one channel name share. @param {unknown} name */
const channelKey = name => String(name ?? "").trim().toLowerCase();

/**
 * One stored row, trusted for shape only; null when it is not a raid entry.
 * A receipt that never got Twitch's answer is shown as unconfirmed.
 *
 * @param {unknown} item @param {number} now
 * @returns {RaidEntry | null}
 */
function readEntry(item, now) {
  const row = object(item);
  const dir = row.dir === "in" || row.dir === "out" ? row.dir : null;
  const channel = typeof row.channel === "string" ? clip(row.channel, 60) : "";
  const at = Number(row.at);
  if (!dir || !channel || typeof row.id !== "string" || !Number.isFinite(at)) return null;
  const stored = dir === "in" ? "received" : OUT_STATES.find(state => state === row.state) || "unconfirmed";
  const lapsed = stored === "pending" && now - at > PENDING_GRACE_MS;
  const reason = typeof row.reason === "string" && row.reason ? { reason: clip(row.reason, 60) } : {};
  return { id: row.id, dir, channel, viewers: Math.max(0, Math.trunc(Number(row.viewers)) || 0), state: lapsed ? "unconfirmed" : stored, at: Math.trunc(at), ...reason };
}

/** @param {unknown} raw @param {number} now @returns {RaidEntry[]} */
function sanitizeHistory(raw, now) {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, HISTORY_LIMIT).map(item => readEntry(item, now)).filter(/** @returns {entry is RaidEntry} */ entry => entry !== null);
}

/**
 * The streamer's newest raid out while it may still be live on Twitch: queued,
 * waiting for Twitch, or not confirmed (Twitch may hold it). It blocks a
 * second start, and a queued or unconfirmed one can be cancelled.
 * @param {RaidEntry[]} history @param {number} now */
function livePendingRaid(history, now) {
  const latest = history.find(entry => entry.dir === "out");
  const open = latest && (latest.state === "queued" || latest.state === "pending" || latest.state === "unconfirmed");
  return latest && open && now - latest.at < RAID_WINDOW_MS ? latest : null;
}

/**
 * Newest interaction per channel name: who the streamer raided, and who
 * raided them.
 *
 * @param {RaidEntry[]} history
 * @returns {Map<string, { relation: "raided" | "raided_by", at: number }>}
 */
function relations(history) {
  /** @type {Map<string, { relation: "raided" | "raided_by", at: number }>} */
  const byChannel = new Map();
  for (const entry of history) {
    if (entry.dir === "out" && entry.state !== "queued" && entry.state !== "closed") continue;
    const key = channelKey(entry.channel);
    const seen = byChannel.get(key);
    if (!seen || entry.at > seen.at) byChannel.set(key, { relation: entry.dir === "out" ? "raided" : "raided_by", at: entry.at });
  }
  return byChannel;
}

/**
 * The channels worth a raid: small channels first, then channels the streamer
 * has raided or been raided by, then the rest. The streamer's own channel is
 * never offered. Twitch channels can be raided; Kick has no raid call, so its
 * channels are listed for the link only.
 *
 * @param {LiveStream[]} streams
 * @param {{ history: RaidEntry[], self: { twitchId: string, kickName: string } }} context
 * @returns {RaidCandidate[]}
 */
function rankCandidates(streams, { history, self }) {
  const known = relations(history);
  const ranked = streams
    .filter(stream => stream.platform === "twitch" ? !self.twitchId || stream.broadcasterId !== self.twitchId
      : !self.kickName || channelKey(stream.channel) !== self.kickName)
    .map(stream => {
      const seen = known.get(channelKey(stream.channel));
      const { id, platform, channel, title, language, viewers, startedAt, url } = stream;
      return { at: seen?.at ?? 0, row: /** @type {RaidCandidate} */ ({ id, platform, channel, title, language, viewers, startedAt, url,
        relation: seen?.relation ?? null, small: viewers <= SMALL_MAX_VIEWERS, raidable: platform === "twitch" && Boolean(stream.broadcasterId) }) };
    });
  /** @param {{ row: RaidCandidate }} item */
  const tier = ({ row }) => (row.small ? 0 : row.relation ? 1 : 2);
  ranked.sort((a, b) => tier(a) - tier(b) || (tier(a) === 1 ? b.at - a.at : 0)
    || a.row.viewers - b.row.viewers || a.row.id.localeCompare(b.row.id));
  return ranked.slice(0, MAX_CANDIDATES).map(({ row }) => row);
}

/**
 * Twitch's refusal, in words the streamer can act on. 400 covers a target
 * that blocks the streamer or does not accept raids, and an oversize party.
 *
 * @param {{ status?: number }} error
 */
function describeRaidFailure(error) {
  const status = Number(error?.status);
  if (status === 401 || status === 403) return { status: 409, code: "reconnect_required", message: "Reconnect Twitch raids in Settings, then try again." };
  if (status === 429) return { status: 429, code: "provider_rate_limited", message: "Twitch limits raid requests to 10 every 10 minutes. Wait a little, then try again." };
  if (status === 409) return { status: 409, code: "raid_already_queued", message: "Twitch says a raid is already queued. Cancel it first." };
  if (status === 404) return { status: 409, code: "raid_target_unknown", message: "Twitch cannot find that channel." };
  if (status === 400) return { status: 409, code: "raid_refused", message: "Twitch refused this raid. The channel may block you or not accept raids." };
  return { status: 424, code: "provider_unavailable", message: "Twitch did not answer. Nothing was changed." };
}

/** @param {{ status?: number }} failure */
function raidFailureError(failure) {
  const { message, status, code } = describeRaidFailure(failure);
  return raidError(message, status, code);
}

module.exports = {
  SMALL_MAX_VIEWERS, HISTORY_LIMIT, RAID_WINDOW_MS, MAX_CANDIDATES,
  raidError, raidSettings, channelKey, sanitizeHistory, livePendingRaid, rankCandidates, raidFailureError,
};
