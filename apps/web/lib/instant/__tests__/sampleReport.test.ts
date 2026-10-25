// @vitest-environment node
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { INSTANT_ENGINE_VERSION } from "../engineVersion";
import { buildInstantReport } from "../report";
import { projectSampleGame, readSampleReport, SAMPLE_MAX_GAMES } from "../sampleReport";
import { SAMPLE_REPORT_AVAILABLE, SAMPLE_REPORT_BUNDLE_ID, SAMPLE_REPORT_ENGINE_VERSION, SAMPLE_REPORT_SOURCE_HASH } from "../sampleAvailability.generated";
import { buildSampleReport, engineSourceHash, isSampleManifest } from "../../../../../scripts/build-sample-report.mjs";
import { bundleIdFor } from "../../../scripts/browser-engine/publish.mjs";

const BUNDLE = "0123456789abcdef", SOURCE = "a".repeat(64);
const raw = () => ({
  gameId: "PRIVATE_GAME_ID", userId: "PRIVATE_OWNER", date: "2026-05-08T19:08:12Z", result: "Victory",
  myRace: "Protoss", map: "Tourmaline LE", durationSec: 470, myBuild: "PvZ - Adept Glaives (Robo)", macroScore: 72,
  myMmr: 5300, myToonHandle: "1-S2-1-123456", gameVersion: "5.0.15.96883", gameBuild: 96883,
  fileName: "PRIVATE_REPLAY.SC2Replay", relativePath: "C:\\PRIVATE_PATH\\private.SC2Replay",
  opponent: { displayName: "PRIVATE_OPPONENT", race: "Zerg", strategy: "ZvP - Speedling Flood", toonHandle: "1-S2-1-987654", pulseId: "PRIVATE_PULSE", pulseCharacterId: "PRIVATE_CHARACTER", mmr: 5100 },
  buildLog: ["[0:00] Nexus", "[0:10] RewardBadge", "[0:18] Pylon"], oppBuildLog: ["[0:00] Hatchery", "[0:45] SpawningPool"],
  macroBreakdown: { privateNested: "PRIVATE_NESTED", raw: { sq: 64, injects_actual: null, supply_blocked_seconds: 8, path: "PRIVATE_RAW" },
    top_3_leaks: [{ name: "Mineral Float", penalty: 4, mineral_cost: 500, detail: "PRIVATE_DETAIL", owner: "PRIVATE_OWNER" }],
    stats_events: [{ time: 0, food_used: 12, army_value: 0, owner: "PRIVATE_OWNER", name: "PRIVATE_ME" }],
    opp_stats_events: [{ time: 0, food_used: 12, army_value: 0, pulseId: "PRIVATE_PULSE" }],
    player_stats: { me: { name: "PRIVATE_ME", pid: 7 }, opponent: { name: "PRIVATE_OPPONENT", pid: 9 } },
  },
  apmCurve: { players: [{ pid: 7, name: "PRIVATE_ME" }] }, spatial: { privatePath: "PRIVATE_SPATIAL" },
});
function document(games = [projectSampleGame(raw())]) { return { schemaVersion: 1, engineVersion: INSTANT_ENGINE_VERSION, engineBundleId: BUNDLE, engineSourceHash: SOURCE, games }; }
const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

describe("public sample allowlist", () => {
  it("retains actual scalar/event values while removing every identity/provenance subtree", () => {
    const input = raw(), before = JSON.stringify(input), game = projectSampleGame(input)!;
    expect(game).toMatchObject({ date: input.date, result: input.result, durationSec: 470, macroScore: 72,
      opponent: { race: "Zerg", strategy: input.opponent.strategy }, macroBreakdown: { raw: { sq: 64, supply_blocked_seconds: 8 }, top_3_leaks: [{ name: "Mineral Float", penalty: 4, mineral_cost: 500 }], stats_events: [{ time: 0, food_used: 12, army_value: 0 }] } });
    expect(game.buildLog).toEqual(["[0:00] Nexus", "[0:18] Pylon"]);
    expect(JSON.stringify(game)).not.toMatch(/PRIVATE|1-S2|gameId|toon|pulse|player_stats|apmCurve|spatial|detail|owner|pid/i);
    expect(JSON.stringify(input)).toBe(before);
  });
  it("rejects identity copied into an otherwise allowed label or build token", () => {
    expect(projectSampleGame({ ...raw(), map: "PRIVATE_OPPONENT" })).toBeNull();
    expect(projectSampleGame({ ...raw(), buildLog: ["[0:10] PRIVATE_OPPONENT"] })).not.toBeNull(); // invalid token is omitted
    expect(projectSampleGame({ ...raw(), myBuild: "1-S2-1-123456" })).toBeNull();
  });
  it("drops free-form leak details, malformed values and unknown leak names rather than inventing evidence", () => {
    const game = projectSampleGame({ ...raw(), macroScore: NaN, macroBreakdown: { raw: { sq: Infinity },
      top_3_leaks: [{ name: "PRIVATE_OPPONENT", penalty: 7 }, { name: "Mineral Float", time: Infinity }],
      stats_events: [{ time: 20, food_used: 33 }, { time: "20", food_used: 50 }] } });
    expect(game).toMatchObject({ macroScore: null, macroBreakdown: { raw: {}, top_3_leaks: [{ name: "Mineral Float" }], stats_events: [{ time: 20, food_used: 33 }] } });
    expect(projectSampleGame({ ...raw(), buildLog: Array(8193).fill("[0:00] Nexus") })).toBeNull();
    expect(projectSampleGame({ ...raw(), date: "2026", result: "unknown" })).toBeNull();
  });
});

describe("sample report reader", () => {
  it("creates only internal sample keys and never combines anonymized players into an invented rivalry/MMR queue", () => {
    const one = projectSampleGame(raw())!, two = projectSampleGame({ ...raw(), result: "Defeat", date: "2026-05-09T19:08:12Z" })!;
    const value = readSampleReport(document([one, two]), BUNDLE)!;
    expect(value.metadata).toMatchObject({ engineVersion: INSTANT_ENGINE_VERSION, engineBundleId: BUNDLE, engineSourceHash: SOURCE });
    expect(value.payloads.map(game => game.gameId)).toEqual(["sample-1", "sample-2"]);
    for (const game of value.payloads) expect(game).toMatchObject({ myToonHandle: null, myMmr: null, opponent: { displayName: null, toonHandle: null, pulseId: null } });
    const report = buildInstantReport(value.payloads, new Date("2026-10-25T00:00:00Z"));
    expect(report.totals).toEqual({ games: 2, wins: 1, losses: 1 }); expect(report.mostFaced).toBeNull(); expect(report.mmr).toBeNull();
    expect(report.macro?.averageScore).toBe(72);
    expect(JSON.stringify(document([one, two]))).not.toContain("gameId");
  });
  it("refuses schema/version/hash drift, extra private keys and malformed/oversized cohorts", () => {
    for (const patch of [{ schemaVersion: 2 }, { engineVersion: "0.0.0" }, { engineSourceHash: "bad" }, { ownerUserId: "PRIVATE_OWNER" }, { games: [] }, { games: Array(SAMPLE_MAX_GAMES + 1).fill(projectSampleGame(raw())) }]) {
      expect(readSampleReport({ ...document(), ...patch }, BUNDLE)).toBeNull();
    }
    expect(readSampleReport(document(), "fedcba9876543210")).toBeNull();
    expect(readSampleReport({ ...document(), games: [{ ...projectSampleGame(raw()), gameId: "PRIVATE_GAME_ID" }] }, BUNDLE)).toBeNull();
    expect(readSampleReport({ ...document(), games: [{ ...projectSampleGame(raw()), opponent: { displayName: "Opponent", race: "Zerg", strategy: "ZvP - Speedling Flood" } }] }, BUNDLE)).toBeNull();
    const reordered = Object.fromEntries(Object.entries(projectSampleGame(raw())!).reverse());
    expect(readSampleReport({ ...document(), games: [reordered] }, BUNDLE)).not.toBeNull();
  });
});

describe("optional sample generation", () => {
  it("checks the content-addressed manifest, including detector/asset changes without a version bump", () => {
    const pending = { engineVersion: INSTANT_ENGINE_VERSION, bundleId: "", assets: [{ role: "engine-bundle", path: "", sha256: SOURCE, bytes: 100 }] };
    const id = bundleIdFor(pending), asset = { ...pending.assets[0], path: `/engine/${INSTANT_ENGINE_VERSION}/${id}/engine.zip` };
    const manifest = { ...pending, bundleId: id, assets: [asset] };
    expect(isSampleManifest(manifest, INSTANT_ENGINE_VERSION, id)).toBe(true);
    expect(isSampleManifest({ ...manifest, assets: [{ ...asset, sha256: "b".repeat(64) }] }, INSTANT_ENGINE_VERSION, id)).toBe(false);
    expect(isSampleManifest({ ...manifest, assets: [{ ...asset, path: "../private.zip" }] }, INSTANT_ENGINE_VERSION, id)).toBe(false);
  });
  it("removes stale output and advertises no button when Python is unavailable", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "sc2tools-sample-test-")); temporary.push(dir);
    const output = path.join(dir, "sample.json"), availability = path.join(dir, "availability.ts");
    await writeFile(output, "STALE_PRIVATE_SAMPLE"); await writeFile(availability, "export const SAMPLE_REPORT_AVAILABLE = true;");
    const value = await buildSampleReport({ output, availability, pythonCandidates: [] });
    expect(value).toEqual({ status: "skipped", reason: "python_unavailable" }); expect(existsSync(output)).toBe(false);
    expect(await readFile(availability, "utf8")).toContain("SAMPLE_REPORT_AVAILABLE = false");
    expect(await readFile(availability, "utf8")).not.toContain(BUNDLE);
  });
  it("removes an earlier sample after an engine/dependency failure without exposing exception details", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "sc2tools-sample-test-")); temporary.push(dir);
    const output = path.join(dir, "sample.json"), availability = path.join(dir, "availability.ts"); await writeFile(output, "STALE_PRIVATE_SAMPLE");
    let calls = 0;
    const value = await buildSampleReport({ output, availability, pythonCandidates: ["mock-python"], execute: async () => { if (calls++ === 0) return ""; throw new Error("PRIVATE_LOCAL_PATH"); } });
    expect(value).toEqual({ status: "skipped", reason: "sample_engine_unavailable" }); expect(existsSync(output)).toBe(false);
    expect(await readFile(availability, "utf8")).toContain("SAMPLE_REPORT_AVAILABLE = false");
  });
  it("the committed sample, when available, matches the engine release and normalized source hash", async () => {
    const output = path.resolve(__dirname, "../../../public/try/sample-payloads.json");
    expect(existsSync(output)).toBe(SAMPLE_REPORT_AVAILABLE);
    if (!SAMPLE_REPORT_AVAILABLE) return;
    const value = JSON.parse(await readFile(output, "utf8"));
    expect(value.engineVersion).toBe(INSTANT_ENGINE_VERSION); expect(value.engineVersion).toBe(SAMPLE_REPORT_ENGINE_VERSION);
    expect(value.engineBundleId).toBe(SAMPLE_REPORT_BUNDLE_ID); expect(value.engineSourceHash).toBe(SAMPLE_REPORT_SOURCE_HASH);
    expect(value.engineSourceHash).toBe(await engineSourceHash()); expect(readSampleReport(value, value.engineBundleId)).not.toBeNull();
  });
});
