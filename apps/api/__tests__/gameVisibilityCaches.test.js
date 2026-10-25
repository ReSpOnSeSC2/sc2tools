// @ts-nocheck
"use strict";

const { OwnerRevisions } = require("../src/util/gameVisibility");
const { TrendsRequests } = require("../src/services/trendsRequests");
const { TickerFactsService } = require("../src/services/tickerFacts");
const { CommunityService } = require("../src/services/community");
const { GameContextService } = require("../src/services/gameContext");
const { OverlayLiveService } = require("../src/services/overlayLive");
function deferred() { let resolve; const promise = new Promise((yes) => { resolve = yes; }); return { promise, resolve }; }

test("owner revision tokens remain bounded and cannot revive after eviction", () => {
  const revisions = new OwnerRevisions(), original = revisions.get("first");
  for (let i = 0; i < 5000; i++) revisions.get(`owner-${i}`);
  expect(revisions.owners.size).toBeLessThanOrEqual(4096);
  expect(revisions.current("first", original)).toBe(false);
  expect(revisions.get("first")).not.toBe(original);
});

test("trends invalidation detaches pending joins and old completion cannot replace fresh metadata", async () => {
  const requests = new TrendsRequests(), old = deferred(), fresh = deferred();
  const first = requests.cached(["metadata", "owner"], () => old.promise, 10000);
  await Promise.resolve();
  await requests.cached(["metadata", "other"], async () => "other-user", 10000);
  requests.invalidateForUser("owner");
  const second = requests.cached(["metadata", "owner"], () => fresh.promise, 10000);
  await Promise.resolve();
  fresh.resolve("fresh"); await expect(second).resolves.toBe("fresh");
  old.resolve("old"); await first;
  const unexpectedRead = jest.fn(async () => "incorrect");
  expect(await requests.cached(["metadata", "owner"], unexpectedRead, 10000)).toBe("fresh");
  expect(await requests.cached(["metadata", "other"], unexpectedRead, 10000)).toBe("other-user");
  expect(unexpectedRead).not.toHaveBeenCalled();
});

test("ticker cache cannot be repopulated by a compute that started before hide", async () => {
  const service = new TickerFactsService({}), old = deferred();
  service._compute = jest.fn().mockImplementationOnce(() => old.promise).mockResolvedValue([{ id: "fresh", text: "fresh" }]);
  const first = service.factsFor("owner");
  service.invalidateForUser("owner");
  expect(await service.factsFor("owner")).toEqual([{ id: "fresh", text: "fresh" }]);
  old.resolve([{ id: "old", text: "old" }]); await first;
  expect(await service.factsFor("owner")).toEqual([{ id: "fresh", text: "fresh" }]);
  expect(service._compute).toHaveBeenCalledTimes(2);
});

test("date-range requests keyed by Mongo owner match also detach on invalidation", async () => {
  const requests = new TrendsRequests(), old = deferred();
  const key = ["dateRange", { userId: "owner", date: { $lte: new Date() } }];
  const first = requests.run(key, () => old.promise); await Promise.resolve();
  requests.invalidateForUser("owner");
  expect(await requests.run(key, async () => "fresh-range")).toBe("fresh-range");
  old.resolve("old-range"); await first;
});

test("community invalidation rejects a pending old availability answer and does not cache it", async () => {
  const service = new CommunityService({}), old = deferred();
  service._opponentScope = async () => ({ filter: {} }); service._opponentRemoved = async () => false;
  service._opponentFloorMet = jest.fn().mockImplementationOnce(() => old.promise).mockResolvedValue(false);
  const first = service.opponentProfileAvailable("opponent");
  await Promise.resolve(); await Promise.resolve();
  service.invalidateForUser("owner");
  expect(await service.opponentProfileAvailable("opponent")).toBe(false);
  old.resolve(true); expect(await first).toBe(false);
  expect(await service.opponentProfileAvailable("opponent")).toBe(false);
  expect(service._opponentFloorMet).toHaveBeenCalledTimes(2);
});

test("game-context invalidation detaches old work, clears only the owner timings and fences its late result", async () => {
  const service = new GameContextService({ games: { findOne: async () => ({ gameId: "current", date: new Date("2026-10-24"), myRace: "Protoss", opponent: { race: "Zerg" } }) } }, { leaguePercentiles: {} });
  const old = deferred();
  service.compute = jest.fn().mockImplementationOnce(() => old.promise).mockResolvedValue({ fresh: true });
  service.timingCache.set(JSON.stringify(["owner", "prior", "Nexus"]), { value: 100, at: 0 });
  service.timingCache.set(JSON.stringify(["other", "prior", "Nexus"]), { value: 200, at: 0 });
  const first = service.get("owner", "current"); await Promise.resolve();
  service.invalidateForUser("owner");
  expect(await service.get("owner", "current")).toEqual({ fresh: true });
  old.resolve({ old: true }); await first;
  expect(await service.get("owner", "current")).toEqual({ fresh: true });
  expect(service.compute).toHaveBeenCalledTimes(2);
  expect([...service.timingCache.values()].map((v) => v.value)).toEqual([200]);
});

test("invalidating context work preserves its active-computation admission bound", async () => {
  const service = new GameContextService({ games: { findOne: async () => ({ gameId: "current", date: new Date("2026-10-24") }) } }, { leaguePercentiles: {} });
  const held = Array.from({ length: 4 }, deferred), pending = [];
  service.compute = jest.fn();
  for (const work of held) service.compute.mockImplementationOnce(() => work.promise);
  for (let i = 0; i < 4; i++) {
    pending.push(service.get("owner", "current")); await Promise.resolve();
    service.invalidateForUser("owner");
  }
  await expect(service.get("owner", "current")).rejects.toMatchObject({ code: "game_context_busy" });
  for (const work of held) work.resolve({ old: true });
  await Promise.all(pending);
  expect(service.cache.size).toBe(0); expect(service.inflight.size).toBe(0);
});

test("overlay invalidation starts a fresh flight and discards old history before broadcast/cache", async () => {
  const service = new OverlayLiveService({}), old = deferred();
  service.buildFromOpponentName = jest.fn().mockImplementationOnce(() => old.promise).mockResolvedValue({ fresh: true });
  const envelope = { gameKey: "one", user: { race: "Protoss" }, opponent: { name: "Synthetic Foe", race: "Zerg" } };
  const first = service.enrichEnvelope("owner", envelope); await Promise.resolve();
  service.invalidateForUser("owner");
  expect((await service.enrichEnvelope("owner", envelope)).streamerHistory).toEqual({ fresh: true });
  old.resolve({ old: true }); expect(await first).toBe(envelope);
  expect((await service.enrichEnvelope("owner", envelope)).streamerHistory).toEqual({ fresh: true });
  expect(service.buildFromOpponentName).toHaveBeenCalledTimes(2);
});
