"use strict";

const { compareVersions } = require("./agentVersion");
const { recentRejections } = require("./ingestRejections");

/**
 * @typedef {"agent_no_folders"|"agent_paused"|"agent_upload_failing"|"agent_outdated_required"
 *   |"replays_skipped_unresolved"|"uploads_rejected"} SyncHealthCode
 * @typedef {"info"|"warn"|"error"} Severity
 * @typedef {{ deviceId: string, lastSeenAt?: Date|null, label?: string, hostname?: string, agentVersion?: string,
 *   agentOs?: string, sync?: import('./types').SyncReport, syncReportedAt?: Date }} SyncDevice
 * @typedef {{ code: SyncHealthCode, severity: Severity, count: number, deviceId?: string, helpSlug: string, fix: string }} SyncHealthRow
 * @typedef {{ minSupportedVersion?: string|null } | null} SyncRelease
 */

/**
 * Sync health rules (roadmap item 76). Pure: the same rows feed
 * GET /v1/me/sync-health and the Doctor. Device rules read only a current
 * sync report, so an old agent (no report), an offline PC or a stale report
 * adds nothing. `uploads_rejected` reads the owner row's rejection window.
 * `fix` names the action a client offers; `helpSlug` is a web help article.
 * @type {Readonly<Record<SyncHealthCode, Readonly<{ severity: Severity, helpSlug: string, fix: string }>>>}
 */
const SYNC_HEALTH_RULES = Object.freeze({
  agent_no_folders: Object.freeze({ severity: "warn", helpSlug: "desktop-app-status", fix: "add_folder" }),
  agent_paused: Object.freeze({ severity: "info", helpSlug: "desktop-app-status", fix: "resume" }),
  agent_upload_failing: Object.freeze({ severity: "error", helpSlug: "desktop-app-status", fix: "retry" }),
  agent_outdated_required: Object.freeze({ severity: "warn", helpSlug: "desktop-app-status", fix: "update_agent" }),
  replays_skipped_unresolved: Object.freeze({ severity: "warn", helpSlug: "my-game-didnt-show-up", fix: "add_identity" }),
  uploads_rejected: Object.freeze({ severity: "warn", helpSlug: "my-game-didnt-show-up", fix: "report" }),
});
// Five heartbeat intervals: a closed, offline or downgraded agent stops counting after that.
const SYNC_REPORT_FRESH_MS = 5 * 60 * 1000;

/** @param {number|undefined} n */
const positive = (n) => (n !== undefined && n > 0 ? n : null);
/** Each device rule returns the row's count, or null when it does not apply.
 * @type {Array<[SyncHealthCode, (sync: import('./types').SyncReport, device: SyncDevice, release: SyncRelease) => number|null]>} */
const DEVICE_RULES = [
  // Count: configured folders that are missing (0 when none is set up).
  ["agent_no_folders", (sync) => (sync.foldersWatched === 0 ? sync.missingFolders ?? 0 : null)],
  // Count: replays waiting to upload.
  ["agent_paused", (sync) => (sync.paused === true ? sync.pending ?? 0 : null)],
  ["agent_upload_failing", (sync) => (sync.paused !== true && sync.lastErrorCode ? positive(sync.pending) : null)],
  // Count: this PC.
  ["agent_outdated_required", (_sync, device, release) => (belowMinimum(device, release) ? 1 : null)],
  ["replays_skipped_unresolved", (sync) => positive(sync.skipped?.player_unresolved)],
];

/** @param {SyncDevice} device @param {SyncRelease} release */
function belowMinimum(device, release) {
  const floor = release && release.minSupportedVersion;
  return Boolean(floor && device.agentVersion && compareVersions(device.agentVersion, floor) < 0);
}

/** @param {unknown} value */
function timeOf(value) {
  return value instanceof Date ? value.getTime() : typeof value === "string" ? Date.parse(value) : NaN;
}

/** A sync report counts only while it is current. @param {SyncDevice} device @param {number} now */
function currentReport(device, now) {
  return Boolean(device.sync && typeof device.sync === "object" && now - timeOf(device.syncReportedAt) <= SYNC_REPORT_FRESH_MS);
}

/** @param {SyncHealthCode} code @param {number} count @param {string} [deviceId] @returns {SyncHealthRow} */
function row(code, count, deviceId) {
  const rule = SYNC_HEALTH_RULES[code];
  return { code, severity: rule.severity, count, ...(deviceId ? { deviceId } : {}), helpSlug: rule.helpSlug, fix: rule.fix };
}

/**
 * Rows in rule order, devices in the given order (listDevices: newest first).
 * Example: deriveSyncHealth({ devices: [{ deviceId: "d1", sync: { paused: true, pending: 2 },
 *   syncReportedAt: new Date() }], ingestStats: null, release: null, now: Date.now() })
 *   → [{ code: "agent_paused", severity: "info", count: 2, deviceId: "d1", helpSlug: "desktop-app-status", fix: "resume" }]
 * @param {{ devices?: SyncDevice[], ingestStats?: Parameters<typeof recentRejections>[0], release?: SyncRelease, now: number }} input
 * @returns {SyncHealthRow[]}
 */
function deriveSyncHealth({ devices = [], ingestStats = null, release = null, now }) {
  const current = devices.filter((device) => currentReport(device, now));
  const rows = DEVICE_RULES.flatMap(([code, countOf]) => current.flatMap((device) => {
    const count = countOf(/** @type {import('./types').SyncReport} */ (device.sync), device, release);
    return count === null ? [] : [row(code, count, String(device.deviceId))];
  }));
  const rejected = recentRejections(ingestStats, now);
  return rejected ? [...rows, row("uploads_rejected", rejected.count)] : rows;
}

/** @param {number} n @param {string} one @param {string} many */
const plural = (n, one, many) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
const UPDATE_CTA = Object.freeze({ label: "Update agent", href: "/download" });
const PROFILE_CTA = Object.freeze({ label: "Set up profile", href: "/settings?tab=profile" });
/** Count-only copy: never a player name, toon handle or PC name.
 * @type {Record<SyncHealthCode, (n: number) => { message: string, cta?: { label: string, href: string } }>} */
const WARNING_COPY = {
  agent_no_folders: () => ({
    message: "The desktop app isn't watching a replay folder, so new games can't sync. Open the app and add your replay folder.",
  }),
  agent_paused: (n) => ({
    message: n > 0
      ? `Syncing is paused in the desktop app. ${plural(n, "game is", "games are")} waiting to upload.`
      : "Syncing is paused in the desktop app. New games will upload when you resume.",
  }),
  agent_upload_failing: (n) => ({
    message: `The desktop app can't upload ${plural(n, "game", "games")}. Open the app and press Retry now, or check its Activity log.`,
  }),
  agent_outdated_required: (n) => ({
    message: n === 1
      ? "Your desktop app is older than the minimum supported version, so it may stop syncing. Update it to keep syncing."
      : `${plural(n, "PC runs", "PCs run")} a desktop app older than the minimum supported version. Update them to keep syncing.`,
    cta: { ...UPDATE_CTA },
  }),
  replays_skipped_unresolved: (n) => ({
    message: `${plural(n, "replay was", "replays were")} skipped because the desktop app couldn't tell which player is you. `
      + "Add your BattleTag or Pulse ID, then re-sync.",
    cta: { ...PROFILE_CTA },
  }),
  uploads_rejected: (n) => ({
    message: `SC2 Tools recently rejected ${plural(n, "upload", "uploads")}. Updating the desktop app usually fixes this; `
      + "if it keeps happening, report a problem.",
  }),
};

/**
 * Doctor warnings: one per code, counts summed across PCs.
 * @param {SyncHealthRow[]} rows
 * @returns {Array<{ id: SyncHealthCode, severity: Severity, message: string, cta?: { label: string, href: string }, helpSlug: string }>}
 */
function syncHealthWarnings(rows) {
  /** @type {Map<SyncHealthCode, number>} */
  const totals = new Map();
  for (const item of rows) totals.set(item.code, (totals.get(item.code) || 0) + item.count);
  return [...totals].map(([code, count]) => {
    const { message, cta } = WARNING_COPY[code](count);
    return { id: code, severity: SYNC_HEALTH_RULES[code].severity, message, ...(cta ? { cta } : {}), helpSlug: SYNC_HEALTH_RULES[code].helpSlug };
  });
}

/**
 * GET /v1/me/sync-health body. `reported: false` means no paired PC has a
 * current sync report, for example an agent that predates sync reports.
 * Only the owner reads this: a current report includes unresolved names.
 * @param {{ devices?: SyncDevice[], ingestStats?: Parameters<typeof recentRejections>[0], rows: SyncHealthRow[], now: number }} input
 */
function syncHealthView({ devices = [], ingestStats = null, rows, now }) {
  const items = devices.map((device) => {
    const reported = currentReport(device, now);
    return { deviceId: String(device.deviceId), label: device.label, hostname: device.hostname, agentVersion: device.agentVersion,
      lastSeenAt: device.lastSeenAt ?? null, reported, ...(reported ? { syncReportedAt: device.syncReportedAt, sync: device.sync } : {}) };
  });
  return { checkedAt: new Date(now).toISOString(), reported: items.some((item) => item.reported), rows, devices: items,
    rejections: recentRejections(ingestStats, now) };
}

/**
 * The release floor for agent_outdated_required. Looked up only when a
 * current report exists, so Doctor reads are unchanged for older agents.
 * Feature-detected and best-effort: no service, or a failed lookup, is null.
 * @param {{ latest?: (opts: { platform?: string }) => Promise<SyncRelease> } | undefined} agentVersion
 * @param {SyncDevice[]} devices @param {number} now
 */
async function syncRelease(agentVersion, devices, now) {
  const reporting = devices.find((device) => currentReport(device, now) && typeof device.agentVersion === "string");
  if (!reporting || !agentVersion || typeof agentVersion.latest !== "function") return null;
  const os = String(reporting.agentOs || "");
  try { return await agentVersion.latest({ platform: /mac/i.test(os) ? "macos" : /linux/i.test(os) ? "linux" : "windows" }); }
  catch { return null; }
}

module.exports = { SYNC_HEALTH_RULES, SYNC_REPORT_FRESH_MS, deriveSyncHealth, syncHealthWarnings, syncHealthView, syncRelease };
