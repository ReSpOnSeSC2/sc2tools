"use strict";

const { captureSessionPublication } = require("../src/services/sessionPublication");
const { GamesService } = require("../src/services/games");
const { SessionPolicyService } = require("../src/services/sessionPolicy");
const { OwnerRevisions } = require("../src/util/gameVisibility");
const { createSessionUpdateScheduler } = require("../src/routes/games");

/** @template [T=void] @param {T} [_sample]
 * @returns {{promise:Promise<T>,resolve:(value:T)=>void}} */
function deferred(_sample) {
  /** @type {(value:T)=>void} */ let resolve = () => {};
  /** @type {Promise<T>} */ const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
function source() {
  const revisions = new OwnerRevisions();
  const sessionPolicy = new SessionPolicyService({ users: { findOne: jest.fn() }, overlayTokens: { findOne: jest.fn() } }, { revisions });
  return { revisions, sessionPolicy, sessionPublicationGuard: GamesService.prototype.sessionPublicationGuard };
}

test("publication captures its original epoch before resolution without adding DTO fields or IO", () => {
  const games = source(), session = { wins: 1, losses: 0, games: 1, sessionGapMinutes: 90 };
  const assertCurrent = captureSessionPublication(games.sessionPublicationGuard.bind(games), "a");
  expect(() => assertCurrent(session)).not.toThrow();
  games.revisions.invalidate("a");
  expect(() => assertCurrent(session)).toThrow("session_policy_changed");
  const fresh = captureSessionPublication(games.sessionPublicationGuard.bind(games), "a");
  const freshSession = { wins: 0, losses: 0, games: 0, sessionGapMinutes: 15 };
  expect(() => fresh(freshSession)).not.toThrow();
  expect(Object.keys(session)).toEqual(["wins", "losses", "games", "sessionGapMinutes"]);
  expect(games.sessionPolicy.db.users.findOne).not.toHaveBeenCalled();
  expect(games.sessionPolicy.db.overlayTokens.findOne).not.toHaveBeenCalled();
});

test.each([undefined, () => null])("a missing production policy guard%p cannot admit policy-bearing results", factory => {
  const assertCurrent = captureSessionPublication(factory, "a");
  expect(() => assertCurrent({ wins: 0, losses: 0, games: 0 })).not.toThrow();
  for (const key of ["sessionGapMinutes", "sessionPolicySource", "storedSessionGapMinutes"]) {
    expect(() => assertCurrent({ wins: 0, [key]: null })).toThrow("session_policy_publication_unavailable");
  }
});

test("the actual ingest scheduler drops a retired awaited response and admits the next fresh fanout", async () => {
  const entered = deferred();
  const oldSession = { wins: 1, losses: 0, games: 1, sessionGapMinutes: 90 };
  const held = deferred(oldSession);
  const freshSession = { wins: 0, losses: 0, games: 0, sessionGapMinutes: 15 };
  const games = { ...source(), todaySession: jest.fn().mockImplementationOnce(async () => { entered.resolve(); return held.promise; }).mockResolvedValue(freshSession) };
  const socket = { data: { kind: "overlay", timezone: "UTC" }, emit: jest.fn() };
  // This unit boundary models only the scheduler's room/socket transport.
  /** @type {{in:(room:string)=>{fetchSockets:()=>Promise<Array<typeof socket>>}}} */
  const io = { in: jest.fn(() => ({ fetchSockets: async () => [socket] })) };
  // The production API accepts a full Socket.IO server; this checked double
  // deliberately supplies only the methods used by this focused transport test.
  const schedule = createSessionUpdateScheduler(/** @type {import('socket.io').Server} */ (/** @type {unknown} */ (io)), /** @type {import('../src/services/games').GamesService} */ (/** @type {unknown} */ (games)));
  const old = schedule("a"); await entered.promise;
  games.revisions.invalidate("a"); held.resolve(oldSession); await old;
  expect(socket.emit).not.toHaveBeenCalled();
  await schedule("a");
  expect(socket.emit).toHaveBeenCalledTimes(1); expect(socket.emit).toHaveBeenCalledWith("overlay:session", freshSession);
  expect(games.todaySession).toHaveBeenCalledTimes(2);
});
