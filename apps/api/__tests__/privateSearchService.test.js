"use strict";

const { EventEmitter } = require("events");
const { BSON } = require("mongodb");
const { PrivateSearchService } = require("../src/services/privateSearchService");
const { PrivateSearchCapacity } = require("../src/services/privateSearchCapacity");
const { decodeCandidates, serializeResponse } = require("../src/services/privateSearchDecode");
/** @typedef {import('mongodb').Document} Document */
/** @typedef {import('mongodb').Collection} Collection */
const AT = new Date("2026-10-27T12:00:00.000Z");
/** @param {string} [id] */
const rival = (id = "pulse-0") => ({ pulseId: id, displayNameSample: "Star rival", race: "Protoss", lastSeen: AT });
const build = () => ({ slug: "own-build", name: "Stalker pressure", race: "Protoss",
  vsRace: "Protoss", perspective: "you", updatedAt: AT });
const owner = () => ({ rows: [{ userId: "owner", clerkUserId: "user_owner", mutationPresent: false }] });
/** @param {Document[]} rows @param {number} [count] */
function facet(rows, count = rows.length) {
  return { rows, source: count ? [{ sourceCount: count, invalidOwner: 0, invalidScope: 0,
    invalidRequired: 0, invalidDate: 0, invalidOptional: 0 }] : [] };
}

class Cursor extends EventEmitter {
  /** @param {Document|Error} value */
  constructor(value) {
    super(); let reads = 0;
    this.next = jest.fn(async () => {
      if (value instanceof Error) throw value;
      return ++reads === 1 ? BSON.serialize(value) : null;
    });
    this.close = jest.fn(async () => { this.emit("close"); });
  }
}

/** @param {Array<Document|Error>} responses */
function collection(responses) {
  /** @type {Cursor[]} */ const cursors = [];
  const aggregate = jest.fn(/** @param {Document[]} _pipeline @param {import('mongodb').AggregateOptions} [_options] */
    (_pipeline, _options) => {
      const cursor = new Cursor(responses.shift() || facet([])); cursors.push(cursor); return cursor;
    });
  return { aggregate, cursors, raw: /** @type {Collection} */ (/** @type {unknown} */ ({ aggregate })) };
}

/** @param {{opponents?:Array<Document|Error>,builds?:Array<Document|Error>,users?:Array<Document|Error>,
 * tombstones?:Array<Document|Error>,games?:Array<Document|Error>,mapsEnabled?:boolean}} [options] */
function fixture(options = {}) {
  const users = collection(options.users || [owner(), owner()]);
  const tombstones = collection(options.tombstones || [{ rows: [] }, { rows: [] }]);
  const opponents = collection(options.opponents || [facet([rival()]), facet([rival()])]);
  const builds = collection(options.builds || [facet([build()]), facet([build()])]);
  const games = collection(options.games || []), capacity = new PrivateSearchCapacity();
  const service = new PrivateSearchService({ users: users.raw, pendingIdentityDeletions: tombstones.raw,
    opponents: opponents.raw, customBuilds: builds.raw, games: games.raw },
  { identityKeyFor: () => "a".repeat(64), mapsEnabled: options.mapsEnabled, capacity });
  const controller = new AbortController();
  const scope = { signal: controller.signal, check: () => {}, clerkUserId: "user_owner" };
  return { service, users, tombstones, opponents, builds, games, capacity, controller, scope };
}

test("actual reader publishes fresh metadata, performs final guards and defers map queries", async () => {
  const f = fixture(), response = JSON.parse(await f.service.quick("owner", "St", f.scope));
  expect(response.version).toBe(2);
  expect(response.groups.opponents).toEqual({ status: "ready",
    items: [{ ...rival(), lastSeen: AT.toISOString() }], hasMore: false });
  expect(response.groups.customBuilds.items[0].slug).toBe("own-build");
  expect(response.groups.maps).toEqual({ status: "unavailable", reason: "deferred", items: [], hasMore: null });
  expect(f.users.aggregate).toHaveBeenCalledTimes(2); expect(f.tombstones.aggregate).toHaveBeenCalledTimes(2);
  expect(f.games.aggregate).not.toHaveBeenCalled();
  const [pipeline, options] = f.opponents.aggregate.mock.calls[1];
  expect(pipeline[0]).toEqual({ $match: { userId: "owner", pulseId: { $in: ["pulse-0"] } } });
  expect(pipeline[1]).toEqual({ $limit: 10 });
  expect(options).toMatchObject({ hint: "userId_1_pulseId_1", raw: true,
    timeoutMS: 300, timeoutMode: "cursorLifetime", comment: "sc2tools-private-search-v2" });
  expect(f.capacity.capacitySnapshot()).toMatchObject({ active: 0, queued: 0, cached: 0 });
  for (const store of [f.users, f.tombstones, f.opponents, f.builds]) {
    for (const cursor of store.cursors) expect(cursor.close).toHaveBeenCalledTimes(1);
  }
});

test.each(["building", "failed"])("an optional opponent index that is %s does no opponent reads or fallback", async key => {
  const f = fixture(), state = key === "building" ? "building" : "failed";
  f.service.ctx.privateSearchIndexes = { settled: Promise.resolve(), status: () => state };
  const response = JSON.parse(await f.service.quick("owner", "St", f.scope));
  expect(response.groups.opponents).toEqual({ status: "unavailable", reason: "missing_access_path", items: [], hasMore: null });
  expect(response.groups.customBuilds.status).toBe("ready");
  expect(f.opponents.aggregate).not.toHaveBeenCalled();
  expect(f.builds.aggregate).toHaveBeenCalledTimes(2);
  expect(f.capacity.capacitySnapshot().active).toBe(0);
});

test("the ninth sentinel participates in publication; changing it retires only that group", async () => {
  const rows = Array.from({ length: 9 }, (_, index) => rival(`pulse-${index}`));
  const changed = rows.map(row => ({ ...row })); changed[8].displayNameSample = "Still a changed private label";
  const f = fixture({ opponents: [facet(rows), facet(changed)] });
  const response = JSON.parse(await f.service.quick("owner", "St", f.scope));
  expect(response.groups.opponents).toEqual({ status: "unavailable", reason: "retired", items: [], hasMore: null });
  expect(response.groups.customBuilds.status).toBe("ready");
  expect(f.opponents.aggregate.mock.calls[1][0][0].$match.pulseId.$in).toHaveLength(9);
});

test.each(["missing", "renamed", "duplicate"])("selected-ID %s publication never repairs a row", async mode => {
  const rows = mode === "missing" ? []
    : mode === "renamed" ? [{ ...rival(), displayNameSample: "Other" }] : [rival(), rival()];
  const f = fixture({ opponents: [facet([rival()]), facet(rows)] });
  const response = JSON.parse(await f.service.quick("owner", "St", f.scope));
  expect(response.groups.opponents.reason).toBe("retired");
  expect(response.groups.opponents.hasMore).toBeNull();
});

test("owner cap failure is per-group and maps require a separate second capped read", async () => {
  const f = fixture({ opponents: [facet([], 4097)], mapsEnabled: true,
    games: [facet([{ map: "Star map" }], 3), facet([{ map: "Star map" }], 3)] });
  const result = JSON.parse(await f.service.quick("owner", "St", f.scope));
  expect(result.groups.opponents.reason).toBe("source_budget_exceeded");
  expect(result.groups.customBuilds.status).toBe("ready");
  expect(result.groups.maps).toEqual({ status: "ready", items: [{ map: "Star map" }], hasMore: false });
  expect(f.games.aggregate).toHaveBeenCalledTimes(2);
  expect(f.games.aggregate.mock.calls[0][0]).toEqual(f.games.aggregate.mock.calls[1][0]);
  expect(f.games.aggregate.mock.calls[0][0][2]).toEqual({ $limit: 4097 });
});

test.each([27, 50])("native fixed code %s becomes only a fixed per-group reason without retries", async code => {
  const f = fixture({ opponents: [Object.assign(new Error("private Mongo query sentinel"), { code })] });
  const result = await f.service.quick("owner", "St", f.scope);
  expect(result).not.toContain("sentinel"); expect(f.opponents.aggregate).toHaveBeenCalledTimes(1);
  expect(JSON.parse(result).groups.opponents.reason).toBe(code === 27 ? "missing_access_path" : "deadline");
  expect(JSON.parse(result).groups.customBuilds.status).toBe("ready");
});

test.each([
  { rows: [] }, { rows: [{ ...owner().rows[0], userId: ["owner"] }] },
  { rows: [{ ...owner().rows[0], clerkUserId: "user_other" }] },
  { rows: [{ ...owner().rows[0], mutationPresent: true }] },
])("initial owner identity/mutation failure blocks every group read %#", async value => {
  const f = fixture({ users: [value] });
  await expect(f.service.quick("owner", "St", f.scope)).rejects.toBeInstanceOf(Error);
  expect(f.opponents.aggregate).not.toHaveBeenCalled(); expect(f.builds.aggregate).not.toHaveBeenCalled();
  expect(f.games.aggregate).not.toHaveBeenCalled();
});

test.each(["initial", "final"])("a %s tombstone rejects the entire response", async stage => {
  const tombstones = stage === "initial" ? [{ rows: [{ present: true }] }]
    : [{ rows: [] }, { rows: [{ present: true }] }];
  const f = fixture({ tombstones });
  await expect(f.service.quick("owner", "St", f.scope)).rejects.toMatchObject({ code: "account_deleted" });
  expect(f.tombstones.aggregate.mock.calls[0][0][0]).toEqual({ $match: { _id: "a".repeat(64) } });
  expect(f.capacity.capacitySnapshot().active).toBe(0);
});

test("invalid ninth data cannot hide inside overflow and private fields cannot reach version2 output", () => {
  const rows = Array.from({ length: 9 }, (_, index) => rival(`pulse-${index}`));
  const malformed = rows.map(row => ({ ...row })); Object.assign(malformed[8], { privatePayload: "source sentinel" });
  const envelope = facet(malformed, 4097);
  expect(decodeCandidates("opponents", [envelope], BSON.serialize(envelope).length).dto).toEqual({
    status: "unavailable", reason: "invalid_data", items: [], hasMore: null,
  });
  expect(() => serializeResponse({ opponents: { status: "ready", items: rows, hasMore: true },
    customBuilds: { status: "ready", items: [], hasMore: false }, maps: { status: "ready", items: [], hasMore: false },
    q: "source sentinel" })).toThrow();
});

test("a failed cursor-close proof is global and quarantines the lane", async () => {
  const f = fixture();
  const original = f.opponents.aggregate.getMockImplementation();
  f.opponents.aggregate.mockImplementation((pipeline, options) => {
    const cursor = original?.(pipeline, options);
    if (!cursor) throw new Error("fixture cursor missing");
    cursor.close.mockRejectedValue(new Error("private close detail")); return cursor;
  });
  await expect(f.service.quick("owner", "St", f.scope))
    .rejects.toMatchObject({ code: "private_search_cleanup_failed" });
  expect(f.capacity.capacitySnapshot().active).toBe(1);
  await expect(f.service.quick("owner", "St", f.scope)).rejects.toMatchObject({ code: "private_search_busy" });
});

test("abort does not release the permit while the actual raw read is still held", async () => {
  const f = fixture();
  /** @type {(value:Uint8Array)=>void} */ let release = () => {};
  /** @type {Promise<Uint8Array>} */ const held = new Promise(resolve => { release = resolve; });
  const original = f.users.aggregate.getMockImplementation();
  f.users.aggregate.mockImplementationOnce((pipeline, options) => {
    const cursor = original?.(pipeline, options);
    if (!cursor) throw new Error("fixture cursor missing");
    cursor.next.mockResolvedValue(null).mockImplementationOnce(() => held); return cursor;
  });
  const worker = f.service.quick("owner", "St", f.scope);
  f.controller.abort(); await Promise.resolve();
  expect(f.capacity.capacitySnapshot().active).toBe(1);
  await expect(f.service.quick("owner", "St", { ...f.scope, signal: new AbortController().signal }))
    .rejects.toMatchObject({ code: "private_search_busy" });
  release(BSON.serialize(owner()));
  await expect(worker).rejects.toMatchObject({ code: "private_search_retired" });
  expect(f.capacity.capacitySnapshot().active).toBe(0);
});
