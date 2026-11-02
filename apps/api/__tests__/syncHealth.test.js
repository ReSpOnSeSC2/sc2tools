// @ts-nocheck
"use strict";

/**
 * Unit: the Sync health rule table (services/syncHealth.js). Device rules
 * read only a current sync report, rejections count only inside the recent
 * window, Doctor copy carries counts and never names, and every helpSlug is
 * a real web help article.
 */

const fs = require("fs");
const path = require("path");
const {
  SYNC_HEALTH_RULES, SYNC_REPORT_FRESH_MS, deriveSyncHealth, syncHealthWarnings, syncHealthView, syncRelease,
} = require("../src/services/syncHealth");
const { REJECTION_WINDOW_MS } = require("../src/services/ingestRejections");

const NOW = Date.parse("2026-11-01T12:00:00Z");
const fresh = new Date(NOW - 30_000);
const device = (sync, over = {}) => ({ deviceId: "pc-1", agentVersion: "0.30.0", agentOs: "Windows", lastSeenAt: fresh, sync, syncReportedAt: fresh, ...over });
const derive = (devices, extra = {}) => deriveSyncHealth({ devices, ingestStats: null, release: null, now: NOW, ...extra });
const codes = (rows) => rows.map((row) => `${row.code}:${row.count}`);
const PRIVATE = { name: "SecretSmurf", toonHandle: "2-S2-1-987654", count: 5 };

test.each([
  ["a healthy report", { foldersWatched: 2, pending: 0, paused: false }, []],
  ["no watched folder", { foldersWatched: 0 }, ["agent_no_folders:0"]],
  ["no watched folder with missing ones", { foldersWatched: 0, missingFolders: 2 }, ["agent_no_folders:2"]],
  ["missing folders beside a watched one", { foldersWatched: 1, missingFolders: 1 }, []],
  ["paused", { paused: true }, ["agent_paused:0"]],
  ["paused with a backlog", { paused: true, pending: 5 }, ["agent_paused:5"]],
  ["an upload error with a backlog", { lastErrorCode: "upload_timeout", pending: 3 }, ["agent_upload_failing:3"]],
  ["an upload error and nothing pending", { lastErrorCode: "upload_timeout", pending: 0 }, []],
  ["a backlog without an error", { pending: 40 }, []],
  ["a paused agent's old upload error", { paused: true, lastErrorCode: "upload_timeout", pending: 2 }, ["agent_paused:2"]],
  ["unresolved skips", { skipped: { player_unresolved: 4, ai_game: 9 }, unresolvedNames: [PRIVATE] }, ["replays_skipped_unresolved:4"]],
  ["only benign skips", { skipped: { ai_game: 9, resumed_replay: 1 } }, []],
  ["counts the rules do not read", { rejected: 4, filtered: 12, archivePending: 3 }, []],
  ["everything at once", { foldersWatched: 0, paused: true, pending: 2, skipped: { player_unresolved: 1 } },
    ["agent_no_folders:0", "agent_paused:2", "replays_skipped_unresolved:1"]],
])("rule table: %s", (_label, sync, expected) => {
  expect(codes(derive([device(sync)]))).toEqual(expected);
});

test("rows carry the rule's severity, helpSlug, fix and the device id", () => {
  expect(derive([device({ paused: true, pending: 1 })])).toEqual([
    { code: "agent_paused", severity: "info", count: 1, deviceId: "pc-1", helpSlug: "desktop-app-status", fix: "resume" },
  ]);
});

test.each([
  ["no report (an older agent)", { sync: undefined, syncReportedAt: undefined }],
  ["a report without a time", { syncReportedAt: undefined }],
  ["a stale report", { syncReportedAt: new Date(NOW - SYNC_REPORT_FRESH_MS - 1) }],
  ["a corrupt report", { sync: "paused" }],
])("device rules ignore %s", (_label, over) => {
  expect(derive([device({ paused: true, foldersWatched: 0 }, over)])).toEqual([]);
});

test("a report exactly at the freshness edge, or ahead of this clock, still counts", () => {
  expect(codes(derive([device({ paused: true }, { syncReportedAt: new Date(NOW - SYNC_REPORT_FRESH_MS) })]))).toEqual(["agent_paused:0"]);
  expect(codes(derive([device({ paused: true }, { syncReportedAt: new Date(NOW + 5_000).toISOString() })]))).toEqual(["agent_paused:0"]);
});

test.each([
  [{ minSupportedVersion: "0.31.0" }, "0.30.9", ["agent_outdated_required:1"]],
  [{ minSupportedVersion: "0.30.0" }, "0.30.0", []],
  [{ minSupportedVersion: null }, "0.1.0", []],
  [null, "0.1.0", []],
  [{ minSupportedVersion: "0.31.0" }, "dev-build", []],
  [{ minSupportedVersion: "0.31.0" }, undefined, []],
])("release %p with agent %p", (release, agentVersion, expected) => {
  expect(codes(derive([device({ pending: 0 }, { agentVersion })], { release }))).toEqual(expected);
});

test("several PCs give rows per PC in rule order; the Doctor sums them per code", () => {
  const rows = derive([
    device({ paused: true, pending: 2, skipped: { player_unresolved: 3 } }, { deviceId: "pc-1" }),
    device({ paused: true, pending: 1 }, { deviceId: "pc-2" }),
    device({ paused: true, pending: 9 }, { deviceId: "pc-old", syncReportedAt: new Date(NOW - 86_400_000) }),
  ], { release: { minSupportedVersion: "9.0.0" } });
  expect(rows.map((row) => `${row.code}:${row.deviceId}:${row.count}`)).toEqual([
    "agent_paused:pc-1:2", "agent_paused:pc-2:1",
    "agent_outdated_required:pc-1:1", "agent_outdated_required:pc-2:1", "replays_skipped_unresolved:pc-1:3",
  ]);
  const warnings = syncHealthWarnings(rows);
  expect(warnings.map((warning) => warning.id)).toEqual(["agent_paused", "agent_outdated_required", "replays_skipped_unresolved"]);
  expect(warnings[0].message).toBe("Syncing is paused in the desktop app. 3 games are waiting to upload.");
  expect(warnings[1].message).toBe("2 PCs run a desktop app older than the minimum supported version. Update them to keep syncing.");
});

describe("uploads_rejected reads only the recent rejection window", () => {
  const stats = (lastRejectedAt, rejected = { validation_failed: 3 }) => ({ rejected, rejectedSince: new Date(NOW - 86_400_000), lastRejectedAt });
  test("a recent rejection adds one account row with no device", () => {
    expect(derive([], { ingestStats: stats(new Date(NOW - 60_000)) })).toEqual([
      { code: "uploads_rejected", severity: "warn", count: 3, helpSlug: "my-game-didnt-show-up", fix: "report" },
    ]);
  });
  test.each([
    ["the window has passed", stats(new Date(NOW - REJECTION_WINDOW_MS - 1))],
    ["no rejection was counted", stats(new Date(NOW - 60_000), {})],
    ["the time is missing", stats(null)],
    ["there are no stats", null],
  ])("nothing when %s", (_label, ingestStats) => {
    expect(derive([], { ingestStats })).toEqual([]);
  });
});

test("Doctor copy is count-only, pluralized, and never names a player, toon handle or PC", () => {
  const rows = derive([device({ foldersWatched: 0, lastErrorCode: "upload_timeout", pending: 1,
    skipped: { player_unresolved: 1 }, unresolvedNames: [PRIVATE] }, { hostname: "SECRET-PC", label: "Secret label" })],
  { release: { minSupportedVersion: "1.0.0" }, ingestStats: { rejected: { validation_failed: 1 }, rejectedSince: fresh, lastRejectedAt: fresh } });
  const warnings = syncHealthWarnings(rows);
  expect(warnings).toEqual([
    { id: "agent_no_folders", severity: "warn", helpSlug: "desktop-app-status",
      message: "The desktop app isn't watching a replay folder, so new games can't sync. Open the app and add your replay folder." },
    { id: "agent_upload_failing", severity: "error", helpSlug: "desktop-app-status",
      message: "The desktop app can't upload 1 game. Open the app and press Retry now, or check its Activity log." },
    { id: "agent_outdated_required", severity: "warn", helpSlug: "desktop-app-status", cta: { label: "Update agent", href: "/download" },
      message: "Your desktop app is older than the minimum supported version, so it may stop syncing. Update it to keep syncing." },
    { id: "replays_skipped_unresolved", severity: "warn", helpSlug: "my-game-didnt-show-up", cta: { label: "Set up profile", href: "/settings?tab=profile" },
      message: "1 replay was skipped because the desktop app couldn't tell which player is you. Add your BattleTag or Pulse ID, then re-sync." },
    { id: "uploads_rejected", severity: "warn", helpSlug: "my-game-didnt-show-up",
      message: "SC2 Tools recently rejected 1 upload. Updating the desktop app usually fixes this; if it keeps happening, report a problem." },
  ]);
  expect(JSON.stringify(warnings)).not.toMatch(/SecretSmurf|987654|SECRET-PC|Secret label|pc-1/);
  expect(syncHealthWarnings(derive([device({ paused: true, pending: 0 })]))[0].message)
    .toBe("Syncing is paused in the desktop app. New games will upload when you resume.");
  expect(syncHealthWarnings(derive([device({ skipped: { player_unresolved: 1234 } })]))[0].message).toMatch(/^1,234 replays were skipped/);
});

test("every helpSlug is a web help article", () => {
  const articles = path.join(__dirname, "../../web/lib/help/articles");
  for (const { helpSlug } of Object.values(SYNC_HEALTH_RULES)) {
    const files = fs.readdirSync(articles, { withFileTypes: true }).filter((entry) => entry.isDirectory())
      .map((entry) => path.join(articles, entry.name, `${helpSlug}.ts`)).filter((file) => fs.existsSync(file));
    expect(files).toHaveLength(1);
    expect(fs.readFileSync(files[0], "utf8")).toMatch(new RegExp(`"?slug"?:\\s*"${helpSlug}"`));
  }
});

describe("the owner's view", () => {
  test("an older agent is reported:false with no stale facts", () => {
    const view = syncHealthView({ devices: [device(undefined, { syncReportedAt: undefined, hostname: "PC" })], rows: [], now: NOW });
    expect(view).toEqual({ checkedAt: "2026-11-01T12:00:00.000Z", reported: false, rows: [], rejections: null,
      devices: [{ deviceId: "pc-1", hostname: "PC", label: undefined, agentVersion: "0.30.0", lastSeenAt: fresh, reported: false }] });
  });
  test("a current report is returned whole to its owner; a stale one is not", () => {
    const sync = { paused: true, unresolvedNames: [PRIVATE] };
    const devices = [device(sync), device({ paused: true }, { deviceId: "pc-2", syncReportedAt: new Date(NOW - SYNC_REPORT_FRESH_MS - 1) })];
    const view = syncHealthView({ devices, rows: derive(devices), now: NOW });
    expect(view.reported).toBe(true);
    expect(view.devices[0]).toMatchObject({ deviceId: "pc-1", reported: true, syncReportedAt: fresh, sync });
    expect(view.devices[1]).toEqual(expect.objectContaining({ deviceId: "pc-2", reported: false }));
    expect(view.devices[1].sync).toBeUndefined();
    expect(view.rows.map((row) => row.deviceId)).toEqual(["pc-1"]);
  });
  test("recent rejections are summarized by code", () => {
    const ingestStats = { rejected: { validation_failed: 2 }, rejectedSince: fresh, lastRejectedAt: fresh };
    expect(syncHealthView({ devices: [], ingestStats, rows: [], now: NOW }).rejections)
      .toEqual({ count: 2, byCode: { validation_failed: 2 }, since: fresh, lastRejectedAt: fresh });
  });
});

describe("the release floor lookup", () => {
  test("runs only for a current report, maps the platform and is best-effort", async () => {
    const latest = jest.fn(async () => ({ minSupportedVersion: "1.0.0" }));
    expect(await syncRelease({ latest }, [device(undefined, { syncReportedAt: undefined })], NOW)).toBeNull();
    expect(latest).not.toHaveBeenCalled();
    expect(await syncRelease({ latest }, [device({ pending: 0 }, { agentOs: "Darwin macOS" })], NOW)).toEqual({ minSupportedVersion: "1.0.0" });
    expect(latest).toHaveBeenLastCalledWith({ platform: "macos" });
    await syncRelease({ latest }, [device({ pending: 0 }, { agentOs: "Linux" })], NOW);
    expect(latest).toHaveBeenLastCalledWith({ platform: "linux" });
    await syncRelease({ latest }, [device({ pending: 0 })], NOW);
    expect(latest).toHaveBeenLastCalledWith({ platform: "windows" });
    expect(await syncRelease({ latest: async () => { throw new Error("db down"); } }, [device({ pending: 0 })], NOW)).toBeNull();
    expect(await syncRelease(undefined, [device({ pending: 0 })], NOW)).toBeNull();
    expect(await syncRelease({}, [device({ pending: 0 })], NOW)).toBeNull();
  });
});
