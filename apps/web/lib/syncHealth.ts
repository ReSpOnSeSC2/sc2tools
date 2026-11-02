/**
 * Sync health (roadmap item 76): the web side of GET /v1/me/sync-health,
 * the stored sync report on GET /v1/devices and the six Doctor warning ids.
 * The API derives the rows (apps/api/src/services/syncHealth.js); this
 * module words them. Pure: no React, hooks or socket, so the pill, the
 * Settings card, Devices and the Doctor all share it.
 *
 * Every sentence here holds counts only. A report's unresolved player names
 * and toon handles are shown by the owner's Settings card alone.
 *
 * Example:
 *   syncHealthItems(answer)[0];
 *   // -> { code: "agent_paused", tone: "info", title: "Syncing is paused",
 *   //      sentence: "Syncing is paused in the desktop app. 2 games are waiting to upload.", ... }
 */
import { agentPresence } from "@/lib/agentPresence";
import { ERROR_CODE_COPY, isBenignImportSkip } from "@/lib/syncReasons";

/** The API's rule order. */
export const SYNC_HEALTH_CODES = [
  "agent_no_folders", "agent_paused", "agent_upload_failing",
  "agent_outdated_required", "replays_skipped_unresolved", "uploads_rejected",
] as const;
export type SyncHealthCode = (typeof SYNC_HEALTH_CODES)[number];
export type SyncTone = "info" | "warn" | "error";

/** The cleaned heartbeat report (apps/api/src/services/syncReport.js). */
export interface SyncReport {
  pending?: number;
  archivePending?: number;
  paused?: boolean;
  foldersWatched?: number;
  missingFolders?: number;
  lastUploadAt?: string;
  lastErrorCode?: string;
  skipped?: Partial<Record<string, number>>;
  rejected?: number;
  filtered?: number;
  /** Other players' names and toon handles: the owner's Settings card only. */
  unresolvedNames?: Array<{ name: string; toonHandle: string; count: number }>;
}

/** One API row. `deviceId` is absent on the account-wide uploads_rejected row. */
export interface SyncHealthRow {
  code: string;
  severity: SyncTone;
  count: number;
  deviceId?: string;
  helpSlug: string;
  fix: string;
}

export interface SyncHealthDevice {
  deviceId: string;
  label?: string;
  hostname?: string;
  agentVersion?: string;
  lastSeenAt: string | null;
  /** The PC's report is current (at most five minutes old). Only then do `sync` and `syncReportedAt` appear. */
  reported: boolean;
  syncReportedAt?: string;
  sync?: SyncReport;
}

/** GET /v1/me/sync-health: owner-only and uncached. */
export interface SyncHealthResponse {
  checkedAt: string;
  /** False when no PC has a current report: an older app, an offline PC or no PC. */
  reported: boolean;
  rows: SyncHealthRow[];
  devices: SyncHealthDevice[];
  /** The 7-day window of rejected uploads, or null outside it. */
  rejections: { count: number; byCode: Record<string, number>; since: string | null; lastRejectedAt: string } | null;
}

/** What a row offers: a step in the desktop app, a page, a help section or the report form. */
export type SyncFix =
  | { kind: "agent"; text: string }
  | { kind: "link"; label: string; href: string }
  | { kind: "help"; label: string; helpSlug: string; anchor: string }
  | { kind: "report"; label: string };

export interface SyncReason {
  title: string;
  tone: SyncTone;
  sentence: (count: number) => string;
  fix: SyncFix;
  helpSlug: string;
  anchor: string;
}

/** Where every Sync health link lands: one section of the article per reason. */
const article = (anchor: string) => ({ helpSlug: "my-game-didnt-show-up", anchor });
const plural = (n: number, one: string, many: string) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

/** The Settings section (id "sync-health" in lib/settingsIndex.ts). */
export const SYNC_HEALTH_SETTINGS_HREF = "/settings?tab=account#sync-health";
/** The article section that explains the card as a whole. */
export const SYNC_HEALTH_HELP = article("sync-health");
/** The section for an app too old to report ("not reported by this app version"). */
export const SYNC_NOT_REPORTED_HELP = article("sync-not-reported");
/** Five heartbeats, as the API's SYNC_REPORT_FRESH_MS: an older report may be out of date. */
export const SYNC_REPORT_FRESH_MS = 5 * 60 * 1000;

export const SYNC_REASONS: Readonly<Record<SyncHealthCode, SyncReason>> = {
  agent_no_folders: {
    title: "No replay folder",
    tone: "warn",
    // The count is configured folders that no longer exist (0 when none is set up).
    sentence: (n) => n > 0
      ? `The desktop app can't find ${plural(n, "replay folder", "replay folders")}, so new games can't sync.`
      : "The desktop app isn't watching a replay folder, so new games can't sync.",
    fix: { kind: "agent", text: "Open the desktop app and add your replay folder." },
    ...article("sync-no-folder"),
  },
  agent_paused: {
    title: "Syncing is paused",
    tone: "info",
    sentence: (n) => n > 0
      ? `Syncing is paused in the desktop app. ${plural(n, "game is", "games are")} waiting to upload.`
      : "Syncing is paused in the desktop app.",
    fix: { kind: "agent", text: "Press Resume syncing in the desktop app." },
    ...article("sync-paused"),
  },
  agent_upload_failing: {
    title: "Uploads are failing",
    tone: "error",
    sentence: (n) => `The desktop app can't upload ${plural(n, "game", "games")}.`,
    fix: { kind: "agent", text: "Open the desktop app and press Retry now." },
    ...article("sync-upload-failing"),
  },
  agent_outdated_required: {
    title: "Update required",
    tone: "warn",
    sentence: () => "This desktop app is older than the minimum supported version, so it may stop syncing.",
    fix: { kind: "link", label: "Update agent", href: "/download" },
    ...article("sync-update-required"),
  },
  replays_skipped_unresolved: {
    title: "Player not recognized",
    tone: "warn",
    sentence: (n) => `${plural(n, "replay was", "replays were")} skipped because the desktop app couldn't tell which player is you.`,
    fix: { kind: "link", label: "Set up profile", href: "/settings?tab=profile" },
    ...article("sync-player-unresolved"),
  },
  uploads_rejected: {
    title: "Uploads rejected",
    tone: "warn",
    sentence: (n) => `SC2 Tools rejected ${plural(n, "upload", "uploads")} in the last 7 days.`,
    fix: { kind: "report", label: "Report" },
    ...article("sync-uploads-rejected"),
  },
};

/** Replays outside a PC's sync date range. Not an API row: the range is the
 * owner's choice and lives in the desktop app, so its fix is a help deep link. */
export const SYNC_WINDOW_REASON: SyncReason = {
  title: "Outside the sync date range",
  tone: "info",
  sentence: (n) => `${plural(n, "replay is", "replays are")} outside the desktop app's sync date range.`,
  fix: { kind: "help", label: "Change sync window", helpSlug: "desktop-app-sync-range", anchor: "choose-range" },
  ...article("sync-date-range"),
};

export function isSyncHealthCode(value: string): value is SyncHealthCode {
  return (SYNC_HEALTH_CODES as readonly string[]).includes(value);
}

/** One worded row. `pc` names the PC for a device row; never a player. */
export interface SyncHealthItem {
  key: string;
  code: string;
  tone: SyncTone;
  title: string;
  sentence: string;
  count: number;
  fix: SyncFix | null;
  helpSlug: string;
  anchor?: string;
  deviceId?: string;
  pc?: string;
}

const TONE_RANK: Record<SyncTone, number> = { error: 0, warn: 1, info: 2 };
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function syncDeviceName(device: Pick<SyncHealthDevice, "label" | "hostname"> | undefined): string {
  return device?.label || device?.hostname || "Your PC";
}

function worded(reason: SyncReason, code: string, count: number, key: string, device?: SyncHealthDevice): SyncHealthItem {
  return { key, code, tone: reason.tone, title: reason.title, sentence: reason.sentence(count), count, fix: reason.fix,
    helpSlug: reason.helpSlug, anchor: reason.anchor,
    ...(device ? { deviceId: device.deviceId, pc: syncDeviceName(device) } : {}) };
}

const listOf = <T,>(value: readonly T[] | null | undefined): readonly T[] => (Array.isArray(value) ? value : []);

/**
 * The API's rows, worded, plus a sync-window row for each reporting PC that
 * leaves replays out. Errors come first, then warnings, then information;
 * the API's order holds within each.
 */
export function syncHealthItems(data: SyncHealthResponse): SyncHealthItem[] {
  const devices = new Map(listOf(data.devices).map((device) => [device.deviceId, device]));
  const items = listOf(data.rows).map((row, index): SyncHealthItem => {
    const device = row.deviceId ? devices.get(row.deviceId) : undefined;
    const key = `${row.code}:${row.deviceId ?? "account"}:${index}`;
    if (isSyncHealthCode(row.code)) return worded(SYNC_REASONS[row.code], row.code, row.count, key, device);
    // A code this web build doesn't know yet still shows, with the API's article.
    return { key, code: row.code, tone: TONE_RANK[row.severity] === undefined ? "warn" : row.severity, title: "Sync check",
      sentence: "The desktop app reported a sync problem.", count: row.count, fix: null,
      helpSlug: SLUG_RE.test(row.helpSlug) ? row.helpSlug : SYNC_HEALTH_HELP.helpSlug,
      ...(device ? { deviceId: device.deviceId, pc: syncDeviceName(device) } : {}) };
  });
  for (const device of devices.values()) {
    const filtered = device.reported ? device.sync?.filtered ?? 0 : 0;
    if (filtered > 0) items.push(worded(SYNC_WINDOW_REASON, "replays_filtered", filtered, `replays_filtered:${device.deviceId}`, device));
  }
  return items.map((item, index) => ({ item, index }))
    .sort((a, b) => TONE_RANK[a.item.tone] - TONE_RANK[b.item.tone] || a.index - b.index)
    .map(({ item }) => item);
}

export interface SyncHealthStatus {
  kind: "attention" | "info" | "healthy" | "no_devices" | "offline" | "not_reported";
  tone: SyncTone | "ok";
  title: string;
  /** Says why no PC reports, or that all is well. */
  sentence?: string;
  action?: { label: string; href: string };
}

type UnreportedState = Required<Pick<SyncHealthStatus, "title" | "sentence" | "action">> & { kind: "no_devices" | "offline" | "not_reported" };

/** Why no PC has a current report: no PC, no PC online, or an online PC whose app predates sync reports. */
function unreportedState(devices: readonly SyncHealthDevice[], checkedAt: string): UnreportedState {
  if (!devices.length) {
    return { kind: "no_devices", title: "No desktop app linked", sentence: "Link your PC to see its sync health here.",
      action: { label: "Link your PC", href: "/devices" } };
  }
  // Presence is judged at the server's checkedAt, the moment the API judged the reports.
  const at = Date.parse(checkedAt);
  if (devices.some((device) => agentPresence(device.lastSeenAt, at) === "online")) {
    return { kind: "not_reported", title: "Sync health not reported",
      sentence: "This desktop app version doesn't report sync health yet. Update it to see sync problems here.",
      action: { label: "Update agent", href: "/download" } };
  }
  return { kind: "offline", title: "Desktop app offline", sentence: "Sync health shows while the desktop app runs on your PC.",
    action: { label: "Open Devices", href: "/devices" } };
}

/**
 * The headline. Rows that need attention name the count; an answer with
 * `reported: false` also explains why no PC reports (see unreportedState),
 * since the account-wide uploads_rejected row can still be there.
 */
export function syncHealthStatus(data: SyncHealthResponse, items: SyncHealthItem[] = syncHealthItems(data)): SyncHealthStatus {
  const attention = items.filter((item) => item.tone !== "info");
  const one = attention.length === 1;
  const headline = attention.length ? `${attention.length} thing${one ? "" : "s"} need${one ? "s" : ""} attention` : null;
  if (!data.reported) {
    const state = unreportedState(listOf(data.devices), data.checkedAt);
    return { ...state, tone: attention[0]?.tone ?? "info", title: headline ?? state.title };
  }
  if (headline) return { kind: "attention", tone: attention[0].tone, title: headline };
  if (items.length) return { kind: "info", tone: "info", title: items[0].title };
  return { kind: "healthy", tone: "ok", title: "Syncing normally", sentence: "Your desktop app reports no sync problems." };
}

/** The unresolved names in one PC's current report. For the owner's Settings card only. */
export function unresolvedNamesFor(data: SyncHealthResponse, deviceId: string | undefined): NonNullable<SyncReport["unresolvedNames"]> {
  const device = listOf(data.devices).find((item) => item.deviceId === deviceId);
  return device?.reported ? [...listOf(device.sync?.unresolvedNames)] : [];
}

export type SkippedReplays = { code: string; count: number; text: string; onPurpose: boolean };

/** A report's other skip counts, worded. player_unresolved has its own row. Counts only. */
export function otherSkippedReplays(sync: SyncReport | undefined): SkippedReplays[] {
  return Object.entries(sync?.skipped ?? {})
    .filter((entry): entry is [string, number] => entry[0] !== "player_unresolved" && typeof entry[1] === "number" && entry[1] > 0)
    .map(([code, count]) => ({ code, count, text: ERROR_CODE_COPY[code] ?? code.replaceAll("_", " "), onPurpose: isBenignImportSkip(code) }));
}

/** Other skip counts for each PC with a current report, by PC name. */
export function otherSkippedByDevice(data: SyncHealthResponse): Array<{ deviceId: string; pc: string; skips: SkippedReplays[] }> {
  return listOf(data.devices).filter((device) => device.reported)
    .map((device) => ({ deviceId: device.deviceId, pc: syncDeviceName(device), skips: otherSkippedReplays(device.sync) }))
    .filter((group) => group.skips.length > 0);
}

const CODE_RE = /^[a-z][a-z0-9_]{0,47}$/;
const countOf = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0);

/**
 * The Report fix's form prefill: reason codes and counts only. It never
 * carries a player name, toon handle or PC name, whatever the report holds.
 */
export function syncReportPrefill(data: SyncHealthResponse): { type: "problem"; subject: string; message: string } {
  const rows = listOf(data.rows).filter((row) => CODE_RE.test(row.code)).map((row) => `- ${row.code}: ${countOf(row.count)}`);
  const rejected = Object.entries(data.rejections?.byCode ?? {}).filter(([code]) => CODE_RE.test(code))
    .map(([code, count]) => `- rejected ${code}: ${countOf(count)}`);
  return {
    type: "problem",
    subject: "Sync health problem",
    message: ["Sync health reasons (codes and counts only):", ...(rows.length ? rows : ["- none"]), ...rejected,
      `Checked: ${data.checkedAt}`, "", "What happened?", ""].join("\n"),
  };
}

export interface DeviceSyncSummary {
  tone: SyncTone | "ok";
  /** The worst rule's title, or "Syncing". */
  label: string;
  /** Count-only details, such as "2 folders" or "3 waiting". */
  details: string[];
  lastUploadAt?: string;
  reportedAt?: string;
  /** Older than five minutes (or undated): muted, as the PC may have changed since. */
  stale: boolean;
}

/**
 * One Devices line from the stored report on GET /v1/devices: state and
 * counts, never names. The rules mirror the API's device rules except the
 * version floor, which needs the release. Null for a PC that never reported.
 */
export function deviceSyncSummary(device: { sync?: SyncReport | null; syncReportedAt?: string | null }, now: number): DeviceSyncSummary | null {
  const sync = device.sync;
  if (!sync || typeof sync !== "object") return null;
  const codes: SyncHealthCode[] = [];
  if (sync.foldersWatched === 0) codes.push("agent_no_folders");
  if (sync.paused === true) codes.push("agent_paused");
  if (sync.paused !== true && sync.lastErrorCode && countOf(sync.pending) > 0) codes.push("agent_upload_failing");
  if (countOf(sync.skipped?.player_unresolved) > 0) codes.push("replays_skipped_unresolved");
  const worst = codes.map((code) => SYNC_REASONS[code]).sort((a, b) => TONE_RANK[a.tone] - TONE_RANK[b.tone])[0];
  const skipped = Object.values(sync.skipped ?? {}).reduce<number>((sum, n) => sum + countOf(n), 0);
  const details = [
    countOf(sync.foldersWatched) > 0 ? plural(countOf(sync.foldersWatched), "folder", "folders") : "",
    typeof sync.pending === "number" ? `${countOf(sync.pending).toLocaleString("en-US")} waiting` : "",
    skipped > 0 ? `${skipped.toLocaleString("en-US")} skipped` : "",
    countOf(sync.filtered) > 0 ? `${countOf(sync.filtered).toLocaleString("en-US")} outside sync range` : "",
  ].filter(Boolean);
  const age = now - Date.parse(device.syncReportedAt ?? "");
  const stale = !(age >= 0 && age <= SYNC_REPORT_FRESH_MS);
  return { tone: stale ? "info" : worst?.tone ?? "ok", label: worst?.title ?? "Syncing", details,
    ...(sync.lastUploadAt ? { lastUploadAt: sync.lastUploadAt } : {}),
    ...(device.syncReportedAt ? { reportedAt: device.syncReportedAt } : {}), stale };
}

/**
 * Help for a Doctor warning. A Sync health id lands on its own section; any
 * other warning may name an article (no section).
 */
export function doctorHelp(warning: { id: string; helpSlug?: string }): { slug: string; anchor?: string; title?: string } | null {
  if (isSyncHealthCode(warning.id)) {
    const reason = SYNC_REASONS[warning.id];
    return { slug: reason.helpSlug, anchor: reason.anchor, title: reason.title };
  }
  return typeof warning.helpSlug === "string" && SLUG_RE.test(warning.helpSlug) ? { slug: warning.helpSlug } : null;
}
