import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SETTINGS_FIELDS, settingsFieldHref } from "../settingsIndex";
import { ERROR_CODE_COPY } from "../syncReasons";
import {
  SYNC_HEALTH_CODES,
  SYNC_HEALTH_SETTINGS_HREF,
  SYNC_REASONS,
  SYNC_WINDOW_REASON,
  deviceSyncSummary,
  doctorHelp,
  otherSkippedByDevice,
  otherSkippedReplays,
  syncHealthItems,
  syncHealthStatus,
  syncReportPrefill,
  unresolvedNamesFor,
  type SyncHealthDevice,
  type SyncHealthResponse,
  type SyncHealthRow,
} from "../syncHealth";

const CHECKED = "2026-11-01T12:00:00.000Z";
const AT = Date.parse(CHECKED);
const ago = (ms: number) => new Date(AT - ms).toISOString();
const API = path.resolve(__dirname, "../../../api/src/services");

function row(code: string, count: number, deviceId?: string, severity: SyncHealthRow["severity"] = "warn"): SyncHealthRow {
  return { code, severity, count, ...(deviceId ? { deviceId } : {}), helpSlug: "my-game-didnt-show-up", fix: "report" };
}
function pc(overrides: Partial<SyncHealthDevice> = {}): SyncHealthDevice {
  return { deviceId: "pc-1", hostname: "GAMING-PC", agentVersion: "0.25.0", lastSeenAt: ago(30_000), reported: true, syncReportedAt: ago(30_000), sync: {}, ...overrides };
}
function answer(overrides: Partial<SyncHealthResponse> = {}): SyncHealthResponse {
  return { checkedAt: CHECKED, reported: true, rows: [], devices: [pc()], rejections: null, ...overrides };
}

describe("the six Sync health reasons", () => {
  it("covers exactly the API's codes, in its rule order", () => {
    const source = readFileSync(path.join(API, "syncHealth.js"), "utf8");
    const rules = source.match(/SYNC_HEALTH_RULES = Object\.freeze\(\{([\s\S]*?)\n\}\);/)?.[1] ?? "";
    expect([...rules.matchAll(/^\s+([a-z_]+): Object\.freeze/gm)].map((match) => match[1])).toEqual([...SYNC_HEALTH_CODES]);
    expect(Object.keys(SYNC_REASONS)).toEqual([...SYNC_HEALTH_CODES]);
  });

  it.each([
    ["agent_no_folders", 0, "warn", "The desktop app isn't watching a replay folder, so new games can't sync.", "agent", "sync-no-folder"],
    ["agent_no_folders", 2, "warn", "The desktop app can't find 2 replay folders, so new games can't sync.", "agent", "sync-no-folder"],
    ["agent_paused", 0, "info", "Syncing is paused in the desktop app.", "agent", "sync-paused"],
    ["agent_paused", 1, "info", "Syncing is paused in the desktop app. 1 game is waiting to upload.", "agent", "sync-paused"],
    ["agent_upload_failing", 1234, "error", "The desktop app can't upload 1,234 games.", "agent", "sync-upload-failing"],
    ["agent_outdated_required", 1, "warn", "This desktop app is older than the minimum supported version, so it may stop syncing.", "link", "sync-update-required"],
    ["replays_skipped_unresolved", 1, "warn", "1 replay was skipped because the desktop app couldn't tell which player is you.", "link", "sync-player-unresolved"],
    ["uploads_rejected", 3, "warn", "SC2 Tools rejected 3 uploads in the last 7 days.", "report", "sync-uploads-rejected"],
  ] as const)("%s (%i) reads as one plain sentence with a %s tone", (code, count, tone, sentence, fix, anchor) => {
    const reason = SYNC_REASONS[code];
    expect(reason.tone).toBe(tone);
    expect(reason.sentence(count)).toBe(sentence);
    expect(reason.fix.kind).toBe(fix);
    expect(reason).toMatchObject({ helpSlug: "my-game-didnt-show-up", anchor });
  });

  it("offers the fixes this slice can do", () => {
    expect(SYNC_REASONS.agent_outdated_required.fix).toEqual({ kind: "link", label: "Update agent", href: "/download" });
    expect(SYNC_REASONS.replays_skipped_unresolved.fix).toEqual({ kind: "link", label: "Set up profile", href: "/settings?tab=profile" });
    expect(SYNC_REASONS.uploads_rejected.fix).toEqual({ kind: "report", label: "Report" });
    expect(SYNC_WINDOW_REASON.fix).toEqual({ kind: "help", label: "Change sync window", helpSlug: "desktop-app-sync-range", anchor: "choose-range" });
  });

  it("links the Settings section the index registers", () => {
    const field = SETTINGS_FIELDS.find((entry) => entry.id === "sync-health")!;
    expect(SYNC_HEALTH_SETTINGS_HREF).toBe(settingsFieldHref(field));
  });
});

describe("worded rows", () => {
  it("names the PC, keeps the account-wide row PC-free and puts errors first", () => {
    const data = answer({
      rows: [row("agent_paused", 2, "pc-1", "info"), row("replays_skipped_unresolved", 5, "pc-1"), row("agent_upload_failing", 4, "pc-2", "error"), row("uploads_rejected", 2)],
      devices: [pc(), pc({ deviceId: "pc-2", hostname: "LAPTOP-7", label: "Laptop" })],
    });
    const items = syncHealthItems(data);
    expect(items.map((item) => item.code)).toEqual(["agent_upload_failing", "replays_skipped_unresolved", "uploads_rejected", "agent_paused"]);
    expect(items[0]).toMatchObject({ tone: "error", title: "Uploads are failing", pc: "Laptop", deviceId: "pc-2", anchor: "sync-upload-failing" });
    expect(items[2].pc).toBeUndefined();
    expect(items[3].pc).toBe("GAMING-PC");
    expect(new Set(items.map((item) => item.key)).size).toBe(items.length);
  });

  it("adds a sync-window row only for a PC with a current report that leaves replays out", () => {
    const items = syncHealthItems(answer({ devices: [pc({ sync: { filtered: 12 } }), pc({ deviceId: "pc-2", reported: false, sync: { filtered: 9 } })] }));
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ code: "replays_filtered", tone: "info", sentence: "12 replays are outside the desktop app's sync date range.",
      fix: { kind: "help", label: "Change sync window" }, anchor: "sync-date-range", pc: "GAMING-PC" });
  });

  it("still shows a code this build doesn't know, with the API's article", () => {
    const [item] = syncHealthItems(answer({ rows: [{ code: "future_code", severity: "error", count: 1, helpSlug: "setup-health", fix: "later" }] }));
    expect(item).toMatchObject({ title: "Sync check", tone: "error", helpSlug: "setup-health", fix: null });
    expect(syncHealthItems(answer({ rows: [{ code: "odd", severity: "warn", count: 1, helpSlug: "../x", fix: "" }] }))[0].helpSlug).toBe("my-game-didnt-show-up");
  });

  it("survives a malformed answer", () => {
    expect(syncHealthItems({ checkedAt: CHECKED, reported: true } as SyncHealthResponse)).toEqual([]);
  });
});

describe("headline", () => {
  it("counts what needs attention and treats a pause as information", () => {
    expect(syncHealthStatus(answer({ rows: [row("agent_upload_failing", 2, "pc-1", "error")] }))).toMatchObject({ kind: "attention", tone: "error", title: "1 thing needs attention" });
    expect(syncHealthStatus(answer({ rows: [row("uploads_rejected", 2), row("replays_skipped_unresolved", 3, "pc-1")] })).title).toBe("2 things need attention");
    expect(syncHealthStatus(answer({ rows: [row("agent_paused", 0, "pc-1", "info")] }))).toMatchObject({ kind: "info", tone: "info", title: "Syncing is paused" });
    expect(syncHealthStatus(answer())).toMatchObject({ kind: "healthy", tone: "ok", title: "Syncing normally" });
  });

  it("splits reported:false into no PC, an offline PC and an app that doesn't report yet", () => {
    expect(syncHealthStatus(answer({ reported: false, devices: [] }))).toMatchObject({ kind: "no_devices", action: { href: "/devices" } });
    const offline = [pc({ reported: false, sync: undefined, syncReportedAt: undefined, lastSeenAt: ago(10 * 60_000) })];
    expect(syncHealthStatus(answer({ reported: false, devices: offline }))).toMatchObject({ kind: "offline", title: "Desktop app offline" });
    const online = [pc({ reported: false, sync: undefined, syncReportedAt: undefined, lastSeenAt: ago(60_000) })];
    expect(syncHealthStatus(answer({ reported: false, devices: online }))).toMatchObject({
      kind: "not_reported", tone: "info", title: "Sync health not reported",
      sentence: "This desktop app version doesn't report sync health yet. Update it to see sync problems here.",
      action: { label: "Update agent", href: "/download" },
    });
  });

  it("keeps the account-wide rejection count when no PC reports", () => {
    const online = [pc({ reported: false, sync: undefined, lastSeenAt: ago(60_000) })];
    expect(syncHealthStatus(answer({ reported: false, devices: online, rows: [row("uploads_rejected", 2)] })))
      .toMatchObject({ kind: "not_reported", tone: "warn", title: "1 thing needs attention" });
  });
});

describe("the owner's own names", () => {
  const names = [{ name: "RivalName", toonHandle: "1-S2-1-424242", count: 5 }];
  it("come only from a current report, for the Settings card", () => {
    const data = answer({ devices: [pc({ sync: { skipped: { player_unresolved: 5 }, unresolvedNames: names } }), pc({ deviceId: "pc-2", reported: false, sync: { unresolvedNames: names } })] });
    expect(unresolvedNamesFor(data, "pc-1")).toEqual(names);
    expect(unresolvedNamesFor(data, "pc-2")).toEqual([]);
    expect(unresolvedNamesFor(data, undefined)).toEqual([]);
  });

  it("never reach the Report prefill: codes and counts only", () => {
    const data = answer({
      rows: [row("replays_skipped_unresolved", 5, "pc-1"), row("uploads_rejected", 3), row("Bad Name", 1)],
      devices: [pc({ hostname: "SECRET-PC", label: "Living room", sync: { skipped: { player_unresolved: 5 }, unresolvedNames: names } })],
      rejections: { count: 3, byCode: { validation_failed: 2, quarantine_failed: 1 }, since: CHECKED, lastRejectedAt: CHECKED },
    });
    const prefill = syncReportPrefill(data);
    expect(prefill).toMatchObject({ type: "problem", subject: "Sync health problem" });
    expect(prefill.message).toBe([
      "Sync health reasons (codes and counts only):",
      "- replays_skipped_unresolved: 5", "- uploads_rejected: 3",
      "- rejected validation_failed: 2", "- rejected quarantine_failed: 1",
      `Checked: ${CHECKED}`, "", "What happened?", "",
    ].join("\n"));
    expect(JSON.stringify(prefill)).not.toMatch(/RivalName|1-S2-1-424242|SECRET-PC|Living room|Bad Name/);
  });
});

describe("Devices line", () => {
  const now = AT;
  it("is null for a PC that never reported", () => {
    expect(deviceSyncSummary({}, now)).toBeNull();
    expect(deviceSyncSummary({ sync: null }, now)).toBeNull();
  });

  it("applies the API's device rules and shows the worst one with counts only", () => {
    const fresh = ago(60_000);
    expect(deviceSyncSummary({ syncReportedAt: fresh, sync: { foldersWatched: 2, pending: 0, lastUploadAt: fresh } }, now))
      .toEqual({ tone: "ok", label: "Syncing", details: ["2 folders", "0 waiting"], lastUploadAt: fresh, reportedAt: fresh, stale: false });
    expect(deviceSyncSummary({ syncReportedAt: fresh, sync: { foldersWatched: 0, missingFolders: 1 } }, now)).toMatchObject({ tone: "warn", label: "No replay folder" });
    expect(deviceSyncSummary({ syncReportedAt: fresh, sync: { paused: true, pending: 3, lastErrorCode: "network" } }, now)).toMatchObject({ tone: "info", label: "Syncing is paused", details: ["3 waiting"] });
    const failing = deviceSyncSummary({ syncReportedAt: fresh, sync: { pending: 4, lastErrorCode: "network", skipped: { player_unresolved: 2, ai_game: 1 }, filtered: 9,
      unresolvedNames: [{ name: "RivalName", toonHandle: "1-S2-1-424242", count: 3 }] } }, now);
    expect(failing).toMatchObject({ tone: "error", label: "Uploads are failing", details: ["4 waiting", "3 skipped", "9 outside sync range"] });
    expect(JSON.stringify(failing)).not.toMatch(/RivalName|424242/);
    expect(deviceSyncSummary({ syncReportedAt: fresh, sync: { pending: 0, lastErrorCode: "network" } }, now)).toMatchObject({ tone: "ok" });
    expect(deviceSyncSummary({ syncReportedAt: fresh, sync: { skipped: { player_unresolved: 1 } } }, now)).toMatchObject({ tone: "warn", label: "Player not recognized" });
  });

  it("mutes a report older than five minutes, or one with no time", () => {
    expect(deviceSyncSummary({ syncReportedAt: ago(5 * 60_000), sync: { pending: 4, lastErrorCode: "x" } }, now)).toMatchObject({ stale: false, tone: "error" });
    expect(deviceSyncSummary({ syncReportedAt: ago(5 * 60_000 + 1), sync: { pending: 4, lastErrorCode: "x" } }, now)).toMatchObject({ stale: true, tone: "info", label: "Uploads are failing" });
    expect(deviceSyncSummary({ sync: { pending: 1 } }, now)).toMatchObject({ stale: true });
  });
});

describe("other skipped replays", () => {
  it("words every skip reason the API keeps, apart from the one with its own row", () => {
    const source = readFileSync(path.join(API, "syncReport.js"), "utf8");
    const reasons = [...(source.match(/SKIP_REASONS = Object\.freeze\(\[([\s\S]*?)\]\)/)?.[1] ?? "").matchAll(/"([a-z_]+)"/g)].map((match) => match[1]);
    expect(reasons).toContain("player_unresolved");
    for (const reason of reasons) expect(ERROR_CODE_COPY[reason], reason).toBeTruthy();
    const skipped = Object.fromEntries(reasons.map((reason) => [reason, 1]));
    expect(otherSkippedReplays({ skipped }).map((item) => item.code)).toEqual(reasons.filter((reason) => reason !== "player_unresolved"));
  });

  it("marks on-purpose skips and groups counts by reporting PC", () => {
    expect(otherSkippedReplays({ skipped: { ai_game: 2, parse_failed: 1, player_unresolved: 4, no_result: 0 } })).toEqual([
      { code: "ai_game", count: 2, text: "Skipped — game vs the AI.", onPurpose: true },
      { code: "parse_failed", count: 1, text: ERROR_CODE_COPY.parse_failed, onPurpose: false },
    ]);
    const data = answer({ devices: [pc({ sync: { skipped: { ai_game: 2 } } }), pc({ deviceId: "pc-2", reported: false, sync: { skipped: { ai_game: 5 } } }), pc({ deviceId: "pc-3", sync: {} })] });
    expect(otherSkippedByDevice(data)).toEqual([{ deviceId: "pc-1", pc: "GAMING-PC", skips: [expect.objectContaining({ code: "ai_game", count: 2 })] }]);
  });
});

describe("Doctor help", () => {
  it("sends each Sync health id to its own section and any other id to the article it names", () => {
    for (const code of SYNC_HEALTH_CODES) {
      expect(doctorHelp({ id: code, helpSlug: "desktop-app-status" })).toEqual({ slug: "my-game-didnt-show-up", anchor: SYNC_REASONS[code].anchor, title: SYNC_REASONS[code].title });
    }
    expect(doctorHelp({ id: "future_check", helpSlug: "setup-health" })).toEqual({ slug: "setup-health" });
    expect(doctorHelp({ id: "no_agent" })).toBeNull();
    expect(doctorHelp({ id: "odd", helpSlug: "javascript:alert(1)" })).toBeNull();
  });
});

describe("purity", () => {
  it("keeps the sync modules free of React, hooks, sockets and components", () => {
    for (const file of ["syncHealth.ts", "syncReasons.ts"]) {
      const source = readFileSync(path.resolve(__dirname, "..", file), "utf8");
      const imports = [...source.matchAll(/^import[^;]*?from\s+"([^"]+)";/gm)].map((match) => match[1]);
      expect(imports.filter((name) => !/^@\/lib\/(?:agentPresence|syncReasons)$/.test(name)), file).toEqual([]);
      expect(source, file).not.toMatch(/"use client"/);
    }
  });
});
