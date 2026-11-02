"use strict";

const { deriveSyncHealth, syncHealthWarnings, syncHealthView, syncRelease } = require("./syncHealth");

/** Shared account diagnostics for the owner and authorized support view.
 * Sync health warnings follow the original four and carry a `helpSlug`;
 * their messages hold counts only, never a player name or toon handle.
 * @param {any} deps
 * @param {string} userId */
async function buildDoctor(deps, userId) {
  /** @type {Array<{id: string, severity: 'info'|'warn'|'error', message: string, cta?: {label: string, href: string}, helpSlug?: string}>} */
  const warnings = [];

  const ownerSnapshot = readDoctorSnapshot(deps.users, userId);
  const [snapshot, devices, gameStats, replayCounts] = await Promise.all([
    ownerSnapshot,
    deps.pairings.listDevices(userId),
    ownerSnapshot.then(owner => owner.statsCandidate ?? deps.games.stats(userId)),
    deps.replayArchiveEnabled
      ? deps.games.replayArchiveStatus(userId)
      : Promise.resolve(emptyReplayArchiveCounts()),
  ]);
  const { profile, replayArchivePrefs } = snapshot;
  const replayArchive = withReplayResyncState(
    replayCounts,
    replayArchivePrefs,
    Boolean(deps.replayArchiveEnabled),
  );

  if (!hasProfileIdentity(profile)) {
    warnings.push({ id: "no_profile", severity: "warn", message: "Your SC2 profile isn't set up yet. Add your BattleTag or a Pulse ID to see opponent matchup stats.", cta: { label: "Set up profile", href: "/settings?tab=profile" } });
  }

  if (devices.length === 0) {
    warnings.push({
      id: "no_agent",
      severity: "warn",
      message:
        "The latest SC2 Tools Agent needs to be turned on or installed.",
      cta: { label: "Install latest agent", href: "/download" },
    });
  }

  if (gameStats.total === 0) {
    warnings.push({
      id: "no_games",
      severity: "info",
      message:
        "No games recorded yet. The agent will import your recent replays automatically after pairing.",
    });
  }

  if (replayArchive.requiresResync) {
    const count = replayArchive.missingGames;
    warnings.push({
      id: "replay_archive_incomplete",
      severity: "warn",
      message:
        `${count.toLocaleString("en-US")} saved ${count === 1 ? "game is" : "games are"} `
        + "missing the original replay file. Update to the latest desktop "
        + "agent, then open it and click Re-sync once. The agent will "
        + "archive replay files still on this PC; files already deleted "
        + "locally will remain unavailable.",
      cta: { label: "Update agent", href: "/download" },
    });
  }

  warnings.push(...syncHealthWarnings(await syncHealthRows(deps, devices, snapshot.ingestStats, Date.now())));
  return { ok: warnings.filter((w) => w.severity !== "info").length === 0, warnings };
}

/** @param {any} deps @param {any[]} devices @param {any} ingestStats @param {number} now */
async function syncHealthRows(deps, devices, ingestStats, now) {
  const release = await syncRelease(deps.agentVersion, devices, now);
  return deriveSyncHealth({ devices, ingestStats, release, now });
}

/** GET /v1/me/sync-health: the Doctor's one owner read (for the rejection
 * window) plus the owner's devices. @param {any} deps @param {string} userId */
async function buildSyncHealth(deps, userId) {
  const now = Date.now();
  const [snapshot, devices] = await Promise.all([readDoctorSnapshot(deps.users, userId), deps.pairings.listDevices(userId)]);
  const rows = await syncHealthRows(deps, devices, snapshot.ingestStats, now);
  return syncHealthView({ devices, ingestStats: snapshot.ingestStats, rows, now });
}

/**
 * A missing object does not necessarily mean the user skipped the rollout:
 * old files may have been deleted from their PC. Stop the one-time prompt as
 * soon as the latest agent has actually requested a full local re-sync, while
 * continuing to expose the honest archived/missing counts.
 *
 * @param {{totalGames: number, archivedGames: number, missingGames: number, archiveComplete: boolean}} counts
 * @param {Record<string, unknown>} prefs
 * @param {boolean} enabled
 */
function withReplayResyncState(counts, prefs, enabled) {
  const backfillVersion =
    prefs
    && typeof prefs.version === "number"
    && Number.isInteger(prefs.version)
  ? prefs.version
  : 0;
  const resyncRequestedAt =
    backfillVersion >= 1
    && prefs
    && typeof prefs.resyncRequestedAt === "string"
  ? prefs.resyncRequestedAt
  : null;
  return {
    ...counts,
    enabled,
    backfillVersion,
    resyncRequestedAt,
    requiresResync:
  enabled
  && counts.totalGames > 0
  && counts.missingGames > 0
  && (backfillVersion < 1 || !resyncRequestedAt),
  };
}

/** Older injected services keep the exact authoritative path; a missing owner
 * never supplies an invented empty stats tuple. @param {any} users @param {string} userId */
async function readDoctorSnapshot(users, userId) {
  if (typeof users.getDoctorSnapshot === "function") return users.getDoctorSnapshot(userId);
  const [profile, replayArchivePrefs] = await Promise.all([
    users.getProfile(userId), users.getPreferences(userId, "replayArchive"),
  ]);
  return { profile, replayArchivePrefs, statsCandidate: null };
}

function emptyReplayArchiveCounts() {
  return {
    totalGames: 0,
    archivedGames: 0,
    missingGames: 0,
    archiveComplete: true,
  };
}

/** Any existing identity signal avoids a false setup warning. @param {any} profile */
function hasProfileIdentity(profile) { return Boolean(profile.battleTag || profile.displayName || (Array.isArray(profile.pulseIds) && profile.pulseIds.length > 0)); }

module.exports = { buildDoctor, buildSyncHealth, withReplayResyncState, emptyReplayArchiveCounts };
