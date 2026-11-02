/** Private Settings actions. Keep this separate from the count-only header
 * and Devices helpers so those surfaces never load identity controls. */
export const SYNC_RETRY_REASONS = ["player_unresolved", "parse_failed", "analysis_failed", "file_unstable", "playback_budget_exceeded", "unsupported_replay"] as const;
export type SyncRetryReason = typeof SYNC_RETRY_REASONS[number];
export type SyncHealthAction = { kind: "identity"; toonHandle: string } | { kind: "retry"; deviceId: string; reason: SyncRetryReason };
export type SyncActionReply = { code: string; count: number };
export type SyncActionFeedback = { error: boolean; text: string; link?: { href: string; text: string } };

export function canRetrySyncReason(reason: string): reason is SyncRetryReason {
  return (SYNC_RETRY_REASONS as readonly string[]).includes(reason);
}
export function syncActionKey(action: SyncHealthAction): string {
  return action.kind === "identity" ? `identity:${action.toonHandle}` : `retry:${action.deviceId}:${action.reason}`;
}

const update = { href: "/download", text: "Update agent" };
const profile = { href: "/settings?tab=profile", text: "Manage accounts in profile" };
const unknownRetry = "Couldn't confirm the retry. Press Check again to see the latest counts before trying again.";

/** Show only our own copy: API/adapter error messages can contain private data. */
export function syncActionFeedback(kind: SyncHealthAction["kind"], result: SyncActionReply | null, error?: unknown): SyncActionFeedback {
  const code = result?.code ?? (error && typeof error === "object" && "code" in error ? error.code : null);
  const status = error && typeof error === "object" && "status" in error ? error.status : null;
  if (kind === "identity") {
    if (result && (code === "added" || code === "already_present") && Number.isSafeInteger(result.count) && result.count > 0 && result.count <= 20) return { error: false, text: `${code === "added" ? "Account added." : "Already in your account."} Retry the unrecognized replays on this PC when you're ready.` };
    if (code === "sync_identity_capacity") return { error: true, text: "Your profile already has 20 accounts. Remove an unused account before adding this one.", link: profile };
    if (code === "sync_identity_busy") return { error: true, text: "Your profile changed while saving. Try adding this account again." };
    if (status === 429) return { error: true, text: "Too many account changes. Wait a minute, then try again." };
    return { error: true, text: "Couldn't save this account. Check your profile, then try adding it again.", link: profile };
  }
  if (result && code === "accepted" && Number.isSafeInteger(result.count) && result.count >= 0) return {
    error: false, text: `${result.count.toLocaleString("en-US")} ${result.count === 1 ? "replay queued" : "replays queued"} for retry. This keeps your sync date range. Press Check again after the desktop app syncs.`,
  };
  if (result && code === "no_matches" && result.count === 0) return { error: false, text: "No matching local replays are ready to retry. Press Check again to refresh the counts." };
  if (code === "sync_agent_unsupported" || code === "unsupported") return { error: true, text: "Update and restart the desktop app on this PC, then retry here.", link: update };
  if (code === "sync_agent_offline") return { error: true, text: "Open the desktop app on this PC and keep it connected, then try again.", link: { href: "/devices", text: "Open Devices" } };
  if (code === "sync_retry_pending" || code === "busy") return { error: true, text: "A retry is already running. Let it finish, then press Check again." };
  if (code === "owner_changed" || code === "sync_owner_changed") return { error: true, text: "The account or PC connection changed. Press Check again before retrying." };
  if (status === 429) return { error: true, text: "Too many retry requests. Wait a minute, then check the counts before retrying." };
  if (code === "local_error") return { error: true, text: "The desktop app couldn't prepare these replays. Check the app on this PC, then press Check again." };
  return { error: true, text: unknownRetry };
}
