// @ts-nocheck
"use strict";
const { startHarness } = require("./helpers/browserIngestHarness");

describe("settled weekly leaderboard", () => {
  let h;
  const weekKey = "2026-W42";
  beforeAll(async () => { h = await startHarness("arcade_leaderboard"); });
  afterAll(async () => { if (h) await h.stop(); });
  beforeEach(async () => { await h.db.arcadeLeaderboard.deleteMany({}); });
  test("ranks settled rows before locks, includes legacy results and strips user ids", async () => {
    await h.db.arcadeLeaderboard.insertMany([
      { userId: "lock", weekKey, pnlPct: 0, settled: false, updatedAt: new Date("2026-10-12") },
      { userId: "legacy", weekKey, pnlPct: -2, updatedAt: new Date("2026-10-13") },
      { userId: "zero", weekKey, pnlPct: 0, settled: true, updatedAt: new Date("2026-10-14") },
    ]);
    const out = await h.services.arcade.listLeaderboard(weekKey, { userId: "legacy" });
    expect(out.items.map((row) => [row.pnlPct, row.rank, row.settled, row.isYou])).toEqual([[0, 1, true, false], [-2, 2, true, true], [0, null, false, false]]);
    expect(out.participants).toBe(3); expect(out.settledCount).toBe(2);
    expect(out.you).toEqual({ rank: 2, pnlPct: -2, settled: true });
    for (const row of out.items) expect(row).not.toHaveProperty("userId");
  });
  test("finds your rank beyond the first page and counts ties by earlier update", async () => {
    const updatedAt = new Date("2026-10-14");
    await h.db.arcadeLeaderboard.insertMany(Array.from({ length: 55 }, (_, i) => ({ userId: `u${i}`, weekKey, pnlPct: 100 - i, settled: true, updatedAt })));
    const out = await h.services.arcade.listLeaderboard(weekKey, { userId: "u54", limit: 2 });
    expect(out.items).toHaveLength(2); expect(out.you.rank).toBe(55); expect(out.participants).toBe(55);
    await h.db.arcadeLeaderboard.insertOne({ userId: "tie", weekKey, pnlPct: 46, settled: true, updatedAt: new Date("2026-10-13") });
    expect((await h.services.arcade.listLeaderboard(weekKey, { userId: "u54" })).you.rank).toBe(56);
  });
  test("caps requested rows at 200", async () => {
    await h.db.arcadeLeaderboard.insertMany(Array.from({ length: 205 }, (_, i) => ({ userId: `u${i}`, weekKey, pnlPct: i, settled: true, updatedAt: new Date() })));
    const out = await h.services.arcade.listLeaderboard(weekKey, { limit: 999 });
    expect(out.items).toHaveLength(200); expect(out.participants).toBe(205); expect(out.you).toBeNull();
  });
  test("stores explicit zero-percent settlement while preserving one row per account/week", async () => {
    expect(await h.services.arcade.submitLeaderboard("mine", { weekKey, pnlPct: 0, settled: false })).toBe(true);
    expect(await h.services.arcade.submitLeaderboard("mine", { weekKey, pnlPct: 0, settled: true })).toBe(true);
    const out = await h.services.arcade.listLeaderboard(weekKey, { userId: "mine" });
    expect(out.participants).toBe(1); expect(out.you).toEqual({ rank: 1, pnlPct: 0, settled: true });
  });
});
