// @ts-nocheck
"use strict";

/**
 * Coverage for the periodic ``overlay:session`` re-emit worker. The
 * 4-hour-inactivity reset baked into ``GamesService.todaySession`` only
 * takes effect when somebody re-asks the service. This worker is what
 * drives that "somebody" on idle overlays — without it the widget
 * would keep showing yesterday's late-evening W-L until the streamer
 * uploads a new game.
 */

const {
  buildSessionRefresher,
  __internal,
} = require("../src/services/sessionRefresher");

function makeFakeIo(sockets) {
  return {
    fetchSockets: jest.fn(async () => sockets),
  };
}

function makeFakeOverlaySocket(userId, tz) {
  return {
    data: {
      kind: "overlay",
      overlayUserId: userId,
      timezone: tz,
    },
    emit: jest.fn(),
  };
}

describe("services/sessionRefresher", () => {
  test("walks every overlay socket and re-emits overlay:session", async () => {
    const a = makeFakeOverlaySocket("u1", "UTC");
    const b = makeFakeOverlaySocket("u2", "America/New_York");
    const io = makeFakeIo([a, b]);
    const games = {
      todaySession: jest.fn(async (userId, tz) => ({
        wins: 1,
        losses: 0,
        games: 1,
        userIdEcho: userId,
        tzEcho: tz,
      })),
    };
    const worker = buildSessionRefresher({ io, games });
    const emitted = await worker.tickNow();
    expect(emitted).toBe(2);
    expect(games.todaySession).toHaveBeenCalledTimes(2);
    expect(a.emit).toHaveBeenCalledWith(
      "overlay:session",
      expect.objectContaining({ userIdEcho: "u1", tzEcho: "UTC" }),
    );
    expect(b.emit).toHaveBeenCalledWith(
      "overlay:session",
      expect.objectContaining({
        userIdEcho: "u2",
        tzEcho: "America/New_York",
      }),
    );
  });

  test("skips non-overlay sockets (web app, agent)", async () => {
    const overlay = makeFakeOverlaySocket("u1", "UTC");
    const webApp = {
      data: { kind: "user", userId: "u1" },
      emit: jest.fn(),
    };
    const agent = {
      data: { kind: "device", userId: "u1" },
      emit: jest.fn(),
    };
    const io = makeFakeIo([webApp, overlay, agent]);
    const games = {
      todaySession: jest.fn(async () => ({ wins: 0, losses: 0, games: 0 })),
    };
    const worker = buildSessionRefresher({ io, games });
    const emitted = await worker.tickNow();
    expect(emitted).toBe(1);
    expect(games.todaySession).toHaveBeenCalledTimes(1);
    expect(overlay.emit).toHaveBeenCalledTimes(1);
    expect(webApp.emit).not.toHaveBeenCalled();
    expect(agent.emit).not.toHaveBeenCalled();
  });

  test("caches resolutions per (userId, tz) so multi-overlay streamers don't fan out", async () => {
    // Two overlays for the same streamer on the same tz — common when
    // a streamer runs OBS + Streamlabs + a phone preview in parallel.
    const obs = makeFakeOverlaySocket("u1", "UTC");
    const slobs = makeFakeOverlaySocket("u1", "UTC");
    const phone = makeFakeOverlaySocket("u1", "America/New_York");
    const io = makeFakeIo([obs, slobs, phone]);
    const games = {
      todaySession: jest.fn(async () => ({ wins: 0, losses: 0, games: 0 })),
    };
    const worker = buildSessionRefresher({ io, games });
    await worker.tickNow();
    // Two unique (userId|tz) buckets even though three overlays were
    // walked: one for u1|UTC (shared by obs+slobs), one for
    // u1|America/New_York (phone).
    expect(games.todaySession).toHaveBeenCalledTimes(2);
    expect(obs.emit).toHaveBeenCalledTimes(1);
    expect(slobs.emit).toHaveBeenCalledTimes(1);
    expect(phone.emit).toHaveBeenCalledTimes(1);
  });

  test("a thrown todaySession does not block other overlays in the same tick", async () => {
    const a = makeFakeOverlaySocket("u1", "UTC");
    const b = makeFakeOverlaySocket("u2", "UTC");
    const io = makeFakeIo([a, b]);
    const games = {
      todaySession: jest.fn(async (userId) => {
        if (userId === "u1") throw new Error("mongo blip");
        return { wins: 0, losses: 0, games: 0 };
      }),
    };
    const logger = {
      child: () => logger,
      info: jest.fn(),
      warn: jest.fn(),
      debug: jest.fn(),
    };
    const worker = buildSessionRefresher({ io, games, logger });
    const emitted = await worker.tickNow();
    expect(emitted).toBe(1);
    expect(a.emit).not.toHaveBeenCalled();
    expect(b.emit).toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalled();
  });

  test("concurrent tickNow() calls coalesce into a single in-flight pass", async () => {
    const overlay = makeFakeOverlaySocket("u1", "UTC");
    const io = makeFakeIo([overlay]);
    let resolveSession;
    const games = {
      todaySession: jest.fn(
        () =>
          new Promise((resolve) => {
            resolveSession = resolve;
          }),
      ),
    };
    const worker = buildSessionRefresher({ io, games });
    const t1 = worker.tickNow();
    const t2 = worker.tickNow();
    expect(t1).toBe(t2);
    // Flush microtasks so the IIFE inside tickNow() awaits past the
    // io.fetchSockets() call and reaches todaySession() — only then
    // does ``resolveSession`` get assigned. Without this the resolver
    // would still be undefined.
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
    expect(typeof resolveSession).toBe("function");
    resolveSession({ wins: 0, losses: 0, games: 0 });
    await Promise.all([t1, t2]);
    expect(games.todaySession).toHaveBeenCalledTimes(1);
    expect(overlay.emit).toHaveBeenCalledTimes(1);
  });

  test("returns a no-op worker when io or games is missing", async () => {
    // Bootstrap path defends against partial wiring during tests / dev
    // stubs — start() must not crash, tick must resolve to zero.
    const a = buildSessionRefresher({ io: null, games: { todaySession: jest.fn() } });
    a.start();
    expect(a.isRunning()).toBe(false);
    expect(await a.tickNow()).toBe(0);
    await a.stop();

    const b = buildSessionRefresher({ io: makeFakeIo([]), games: null });
    b.start();
    expect(b.isRunning()).toBe(false);
    expect(await b.tickNow()).toBe(0);
    await b.stop();
  });

  test("clampInterval enforces a sane minimum and a default", () => {
    const { clampInterval, DEFAULT_INTERVAL_MS, MIN_INTERVAL_MS } = __internal;
    expect(clampInterval(undefined)).toBe(DEFAULT_INTERVAL_MS);
    expect(clampInterval(0)).toBe(DEFAULT_INTERVAL_MS);
    expect(clampInterval(-100)).toBe(DEFAULT_INTERVAL_MS);
    expect(clampInterval(NaN)).toBe(DEFAULT_INTERVAL_MS);
    // Below the floor — clamps up to the minimum.
    expect(clampInterval(1000)).toBe(MIN_INTERVAL_MS);
    // Above the floor — passes through.
    expect(clampInterval(10 * 60 * 1000)).toBe(10 * 60 * 1000);
  });
});
