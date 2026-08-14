// @ts-nocheck
"use strict";

const {
  createSessionUpdateScheduler,
} = require("../src/routes/games");

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function waitFor(predicate, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

describe("games route session-update scheduler", () => {
  test("coalesces a burst to one active plus one trailing refresh", async () => {
    const releases = [];
    const calls = [];
    let active = 0;
    let maxActive = 0;
    const socket = {
      data: { kind: "overlay", timezone: "America/New_York" },
      emit: jest.fn(),
    };
    const io = {
      in: jest.fn(() => ({
        fetchSockets: jest.fn(async () => [socket]),
      })),
    };
    const games = {
      todaySession: jest.fn((userId, timezone, opts) => {
        calls.push({ userId, timezone, opts });
        active += 1;
        maxActive = Math.max(maxActive, active);
        const gate = deferred();
        releases.push(() => {
          active -= 1;
          gate.resolve({ games: calls.length, wins: 0, losses: 0 });
        });
        return gate.promise;
      }),
    };
    const schedule = createSessionUpdateScheduler(io, games);

    const drain = schedule("user-1", { refreshCurrentMmr: false });
    await waitFor(() => calls.length === 1);

    // An arbitrary resync burst occupies one trailing slot. A fresh game in
    // the middle promotes that slot to force-refresh current MMR; later stale
    // batches cannot downgrade it again.
    for (let i = 0; i < 50; i += 1) {
      schedule("user-1", { refreshCurrentMmr: false });
    }
    schedule("user-1", { refreshCurrentMmr: true });
    for (let i = 0; i < 50; i += 1) {
      schedule("user-1", { refreshCurrentMmr: false });
    }

    expect(calls).toHaveLength(1);
    expect(maxActive).toBe(1);
    releases.shift()();

    await waitFor(() => calls.length === 2);
    expect(calls[0].opts).toEqual({
      refreshCurrentMmr: false,
      reuseRecent: true,
    });
    expect(calls[1].opts).toEqual({
      refreshCurrentMmr: true,
      reuseRecent: true,
    });
    expect(maxActive).toBe(1);
    releases.shift()();
    await drain;

    expect(calls).toHaveLength(2);
    expect(active).toBe(0);
    expect(socket.emit).toHaveBeenCalledTimes(2);
  });

  test("cleans up after a failed socket lookup so later refreshes run", async () => {
    const failure = new Error("socket adapter unavailable");
    const fetchSockets = jest
      .fn()
      .mockRejectedValueOnce(failure)
      .mockResolvedValue([]);
    const io = {
      in: jest.fn(() => ({ fetchSockets })),
    };
    const games = { todaySession: jest.fn() };
    const onError = jest.fn();
    const schedule = createSessionUpdateScheduler(io, games);

    await schedule("user-1", {}, onError);
    await schedule("user-1", {}, onError);

    expect(fetchSockets).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(failure);
    expect(games.todaySession).not.toHaveBeenCalled();
  });

  test("keeps different users independent", async () => {
    const gates = new Map();
    const io = {
      in: jest.fn(() => ({
        fetchSockets: jest.fn(async () => [
          { data: { kind: "overlay", timezone: "UTC" }, emit: jest.fn() },
        ]),
      })),
    };
    const games = {
      todaySession: jest.fn((userId) => {
        const gate = deferred();
        gates.set(userId, gate);
        return gate.promise;
      }),
    };
    const schedule = createSessionUpdateScheduler(io, games);

    const a = schedule("user-a");
    const b = schedule("user-b");
    await waitFor(() => games.todaySession.mock.calls.length === 2);

    expect(new Set(games.todaySession.mock.calls.map((call) => call[0]))).toEqual(
      new Set(["user-a", "user-b"]),
    );
    gates.get("user-a").resolve({ games: 1 });
    gates.get("user-b").resolve({ games: 1 });
    await Promise.all([a, b]);
  });
});
