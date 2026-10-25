import config from "../../api/src/config/twitchAutomation.json";

export type TwitchAutomationPreferences = { predictionsEnabled: boolean; markersEnabled: boolean; windowSec: number; titleTemplate: string };
export const DEFAULT_TWITCH_AUTOMATION: TwitchAutomationPreferences = { ...config.defaults };
export type TwitchPredictionStatus = "disabled" | "skipped" | "pending" | "creating" | "active" | "locked" | "resolving" | "canceling" | "resolved" | "canceled" | "unknown" | "error";
export type TwitchCurrent = { gameKey: string; prediction: TwitchPredictionStatus; marker: string; reason: string | null; canCancel: boolean; canResolve: boolean; deadlineAt: string | null };
export type TwitchAutomationStatus = { serverEnabled: boolean; configured: boolean; connected: boolean; predictionPermission: boolean; markerPermission: boolean;
  eligible: boolean | null; isLive: boolean | null; reason: string | null; rankedQueueSupported: false; capabilityReason: string; preferences: TwitchAutomationPreferences; current: TwitchCurrent | null };
const states = new Set(["disabled", "skipped", "pending", "creating", "active", "locked", "resolving", "canceling", "resolved", "canceled", "unknown", "error"]);
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
export function validTwitchTemplate(value: string): boolean {
  return value.trim().length > 0 && Array.from(value).length <= config.limits.templateChars && !/[<>\p{Cc}\u2028\u2029]/u.test(value)
    && !/[{}]/.test(value.replace(/\{(?:me|opp|oppRace|oppMmr)\}/g, ""));
}
export function twitchPreferences(raw: unknown): TwitchAutomationPreferences {
  const row = object(raw);
  return { predictionsEnabled: row.predictionsEnabled === true, markersEnabled: row.markersEnabled === true,
    windowSec: Number.isInteger(row.windowSec) && Number(row.windowSec) >= 30 && Number(row.windowSec) <= 300 ? Number(row.windowSec) : 120,
    titleTemplate: typeof row.titleTemplate === "string" && validTwitchTemplate(row.titleTemplate) ? row.titleTemplate : DEFAULT_TWITCH_AUTOMATION.titleTemplate };
}
export function twitchCurrent(raw: unknown): TwitchCurrent | null {
  const row = object(raw);
  if (typeof row.gameKey !== "string" || !row.gameKey || row.gameKey.length > 120 || /[\p{Cc}]/u.test(row.gameKey) || !states.has(String(row.prediction))) return null;
  return { gameKey: row.gameKey, prediction: row.prediction as TwitchPredictionStatus, marker: typeof row.marker === "string" && row.marker.length <= 20 ? row.marker : "unknown",
    reason: typeof row.reason === "string" && /^[a-z_]{1,80}$/.test(row.reason) ? row.reason : null,
    canCancel: row.canCancel === true && ["pending", "creating", "active", "locked", "unknown"].includes(String(row.prediction)),
    canResolve: row.canResolve === true && ["active", "locked", "unknown"].includes(String(row.prediction)),
    deadlineAt: typeof row.deadlineAt === "string" && Number.isFinite(Date.parse(row.deadlineAt)) ? row.deadlineAt : null };
}
export function twitchStatus(raw: unknown): TwitchAutomationStatus {
  const row = object(raw);
  return { serverEnabled: row.serverEnabled === true, configured: row.configured === true, connected: row.connected === true,
    predictionPermission: row.predictionPermission === true, markerPermission: row.markerPermission === true,
    eligible: typeof row.eligible === "boolean" ? row.eligible : null, isLive: typeof row.isLive === "boolean" ? row.isLive : null,
    reason: typeof row.reason === "string" && /^[a-z_]{1,80}$/.test(row.reason) ? row.reason : null,
    rankedQueueSupported: false, capabilityReason: "ranked_status_unavailable", preferences: twitchPreferences(row.preferences), current: twitchCurrent(row.current) };
}
const reasons: Record<string, string> = {
  server_not_enabled: "Twitch automation is paused by the server owner. Saving preferences cannot activate it.",
  connect_twitch: "Connect your Twitch account to check broadcaster eligibility and permissions.",
  affiliate_or_partner_required: "Twitch automation requires an affiliate or partner broadcaster.",
  channel_offline: "Your Twitch channel is offline. Predictions and markers wait for a live stream.",
  reconnect_required: "Reconnect Twitch and approve the missing automation permission.",
  channel_unverified: "The channel could not be verified. Refresh status before enabling automation.",
  provider_rate_limited: "Twitch rate limited this operation. Check its status before retrying.",
  ranked_status_unavailable: "Current desktop telemetry cannot prove ranked queue status, so automatic Twitch Predictions are skipped. Live 1v1 markers can still work.",
  rematch_cooldown: "A prediction for this opponent was opened within the last 10 minutes. This rematch is skipped.",
  provider_unconfirmed: "Twitch did not confirm this operation. Check the Twitch dashboard before retrying.",
  channel_not_live_or_eligible: "The Twitch channel was no longer live or eligible when the game started. Refresh Twitch status before the next game.",
  outcome_ids_unavailable: "The outcome IDs were not confirmed. Resolution is unavailable; the known prediction will be refunded after 20 minutes.",
  prediction_account_changed: "This prediction belongs to a previously connected Twitch broadcaster. Reconnect that broadcaster or check its Twitch dashboard.",
};
export const twitchReason = (reason: string | null | undefined): string => reason ? reasons[reason] || "This operation is unavailable. Check the Twitch dashboard and refresh status." : "";
export const TWITCH_STATE_LABELS: Record<TwitchPredictionStatus, string> = { disabled: "Off", skipped: "Skipped", pending: "Waiting", creating: "Opening", active: "Open", locked: "Locked",
  resolving: "Resolving", canceling: "Refunding", resolved: "Resolved", canceled: "Canceled / refunded", unknown: "Unconfirmed", error: "Unavailable" };
