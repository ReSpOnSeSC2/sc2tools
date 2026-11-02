// @ts-nocheck
"use strict";

/**
 * Unit: the Doctor appends Sync health warnings (roadmap item 76) after its
 * original four, which stay byte-identical; older agents add nothing, the
 * new warnings carry a helpSlug, and no message names a player.
 */

const { buildDoctor } = require("../src/services/doctor");

// Copied from services/doctor.js before item 76 so any drift in the original warnings fails here.
const ORIGINAL = {
  no_profile: { id: "no_profile", severity: "warn", message: "Your SC2 profile isn't set up yet. Add your BattleTag or a Pulse ID to see opponent matchup stats.", cta: { label: "Set up profile", href: "/settings?tab=profile" } },
  no_agent: { id: "no_agent", severity: "warn", message: "The latest SC2 Tools Agent needs to be turned on or installed.", cta: { label: "Install latest agent", href: "/download" } },
  no_games: { id: "no_games", severity: "info", message: "No games recorded yet. The agent will import your recent replays automatically after pairing." },
  replay_archive_incomplete: { id: "replay_archive_incomplete", severity: "warn", message: "2 saved games are missing the original replay file. Update to the latest desktop agent, then open it and click Re-sync once. The agent will archive replay files still on this PC; files already deleted locally will remain unavailable.", cta: { label: "Update agent", href: "/download" } },
};
const PRIVATE = { name: "SecretSmurf", toonHandle: "2-S2-1-987654", count: 6 };
const fresh = () => new Date(Date.now() - 10_000);

function deps({ devices = [], ingestStats = null, profile = {}, total = 0, missing = 2, agentVersion } = {}) {
  return {
    users: { getDoctorSnapshot: jest.fn(async () => ({ profile, statsCandidate: { total, latest: null }, replayArchivePrefs: {}, ingestStats })) },
    pairings: { latestAgent: jest.fn(), listDevices: jest.fn(async () => devices) },
    games: { stats: jest.fn(), replayArchiveStatus: jest.fn(async () => ({ totalGames: 2, archivedGames: 2 - missing, missingGames: missing, archiveComplete: missing === 0 })) },
    replayArchiveEnabled: true,
    ...(agentVersion ? { agentVersion } : {}),
  };
}

test("with no PC the original four warnings are byte-identical", async () => {
  const doctor = await buildDoctor(deps(), "owner");
  expect(JSON.stringify(doctor)).toBe(JSON.stringify({ ok: false,
    warnings: [ORIGINAL.no_profile, ORIGINAL.no_agent, ORIGINAL.no_games, ORIGINAL.replay_archive_incomplete] }));
});

test("an older agent (no sync report) adds nothing and looks up no release", async () => {
  const latest = jest.fn();
  const doctor = await buildDoctor(deps({ devices: [{ deviceId: "pc-1", agentVersion: "0.20.0", lastSeenAt: new Date() }], agentVersion: { latest } }), "owner");
  expect(JSON.stringify(doctor)).toBe(JSON.stringify({ ok: false,
    warnings: [ORIGINAL.no_profile, ORIGINAL.no_games, ORIGINAL.replay_archive_incomplete] }));
  expect(latest).not.toHaveBeenCalled();
});

test("current reports append count-only sync warnings with a helpSlug after the originals", async () => {
  const devices = [{ deviceId: "pc-1", hostname: "SECRET-PC", agentVersion: "0.30.0", lastSeenAt: fresh(), syncReportedAt: fresh(),
    sync: { paused: true, pending: 4, skipped: { player_unresolved: 6 }, unresolvedNames: [PRIVATE] } }];
  const ingestStats = { rejected: { validation_failed: 2 }, rejectedSince: fresh(), lastRejectedAt: fresh() };
  const doctor = await buildDoctor(deps({ devices, ingestStats, agentVersion: { latest: async () => ({ minSupportedVersion: null }) } }), "owner");
  expect(JSON.stringify(doctor.warnings.slice(0, 3)))
    .toBe(JSON.stringify([ORIGINAL.no_profile, ORIGINAL.no_games, ORIGINAL.replay_archive_incomplete]));
  expect(doctor.warnings.slice(3).map((warning) => [warning.id, warning.severity, warning.helpSlug])).toEqual([
    ["agent_paused", "info", "desktop-app-status"],
    ["replays_skipped_unresolved", "warn", "my-game-didnt-show-up"],
    ["uploads_rejected", "warn", "my-game-didnt-show-up"],
  ]);
  expect(doctor.warnings[3].message).toBe("Syncing is paused in the desktop app. 4 games are waiting to upload.");
  expect(JSON.stringify(doctor)).not.toMatch(/SecretSmurf|987654|SECRET-PC|pc-1/);
});

test("an info-only paused warning leaves a healthy account ok", async () => {
  const devices = [{ deviceId: "pc-1", lastSeenAt: fresh(), syncReportedAt: fresh(), sync: { paused: true } }];
  const doctor = await buildDoctor(deps({ devices, profile: { battleTag: "Owner#1" }, total: 3, missing: 0 }), "owner");
  expect(doctor.ok).toBe(true);
  expect(doctor.warnings.map((warning) => warning.id)).toEqual(["agent_paused"]);
});

test("the release floor flags a current but outdated agent; a failed lookup flags nothing", async () => {
  const devices = [{ deviceId: "pc-1", agentVersion: "0.30.0", agentOs: "Windows", lastSeenAt: fresh(), syncReportedAt: fresh(), sync: { pending: 0 } }];
  const base = { devices, profile: { battleTag: "Owner#1" }, total: 3, missing: 0 };
  const outdated = await buildDoctor(deps({ ...base, agentVersion: { latest: async () => ({ minSupportedVersion: "0.31.0" }) } }), "owner");
  expect(outdated).toEqual({ ok: false, warnings: [{ id: "agent_outdated_required", severity: "warn", helpSlug: "desktop-app-status",
    cta: { label: "Update agent", href: "/download" },
    message: "Your desktop app is older than the minimum supported version, so it may stop syncing. Update it to keep syncing." }] });
  const failed = await buildDoctor(deps({ ...base, agentVersion: { latest: async () => { throw new Error("releases down"); } } }), "owner");
  expect(failed).toEqual({ ok: true, warnings: [] });
});
