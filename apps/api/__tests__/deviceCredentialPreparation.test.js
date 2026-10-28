"use strict";

const { Timestamp } = require("mongodb");
const { prepareCredentialAuthority } = require("../src/services/deviceCredentialPreparation");
const { activeAuthority, deferred } = require("./helpers/deviceAuthFixture");

function fixture() {
  const row = { ...activeAuthority(), mode: "prepared" };
  /** @type {any} */ const session = { operationTime: new Timestamp({ t: 10, i: 1 }), advanceOperationTime: jest.fn(), endSession: jest.fn(async () => {}) };
  /** @type {jest.Mock} */
  const command = jest.fn(async (/** @type {any} */ body) => body.findAndModify
    ? { ok: 1, lastErrorObject: { n: 1 }, value: row } : { ok: 1, cursor: { firstBatch: [row] } });
  const client = { startSession: jest.fn(() => session), db: () => ({ command }) };
  return { row, session, command, collection: { client, dbName: "local", collectionName: "jobLocks" } };
}

test.each(["writeConcernError", "ok", "match", "floor", "denied"])("failed/unknown %s preparation cannot dispatch a validation fallback", async mode => {
  const f = fixture();
  if (mode === "floor") f.session.operationTime = undefined;
  if (mode === "denied") f.command.mockRejectedValueOnce(new Error("denied"));
  if (mode === "writeConcernError") f.command.mockResolvedValueOnce({ ok: 1, lastErrorObject: { n: 1 }, value: f.row, writeConcernError: { code: 64 } });
  if (mode === "ok") f.command.mockResolvedValueOnce({ ok: 0, lastErrorObject: { n: 1 }, value: f.row });
  if (mode === "match") f.command.mockResolvedValueOnce({ ok: 1, lastErrorObject: { n: 0 }, value: f.row });
  await expect(prepareCredentialAuthority(f.collection, 5000, () => 0, "causal")).rejects.toThrow();
  expect(f.command).toHaveBeenCalledTimes(1); expect(f.session.endSession).toHaveBeenCalledTimes(1);
});

test("only a declared positive standalone capability can validate without a floor", async () => {
  const f = fixture(); f.session.operationTime = undefined;
  expect(await prepareCredentialAuthority(f.collection, 5000, () => 0, "writer-only-standalone")).toEqual(f.row);
  expect(f.command.mock.calls[1][0]).not.toHaveProperty("readConcern");
  expect(f.row.mode).toBe("prepared");
  const unknown = fixture(); await expect(prepareCredentialAuthority(unknown.collection, 5000, () => 0, "unavailable")).rejects.toThrow("topology_unavailable");
  expect(unknown.command).not.toHaveBeenCalled(); expect(unknown.collection.client.startSession).not.toHaveBeenCalled();
});

test("publication waits for actual owned session cleanup", async () => {
  const f = fixture(), held = deferred(); f.session.endSession.mockImplementationOnce(() => held.promise);
  let done = false;
  const work = prepareCredentialAuthority(f.collection, 5000, () => 0, "causal").then(value => { done = true; return value; });
  for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
  expect(f.session.endSession).toHaveBeenCalledTimes(1); expect(done).toBe(false);
  held.resolve(); expect(await work).toEqual(f.row); expect(done).toBe(true);
});
