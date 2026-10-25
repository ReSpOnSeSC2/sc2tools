// @ts-nocheck
"use strict";
const { overlayDescriptor, overlayHandshakeDescriptor, summarizeOverlayPresence, readOverlayPresence } = require("../src/services/overlayPresence");
const { attachSocketAuth } = require("../src/socket/auth");
const { LiveGameBroker } = require("../src/services/liveGameBroker");

describe("overlay surface descriptors", () => {
  test.each([
    [{ surface: "all-in-one" }, { surface: "all-in-one", widget: null }],
    [{ surface: "widget", widget: "ghost-build" }, { surface: "widget", widget: "ghost-build" }],
    [{ surface: "widget", widget: "scouting" }, { surface: "widget", widget: "scouting" }],
    [{ surface: "scene", widget: "brb" }, { surface: "scene", widget: "brb" }],
    [{ surface: "scene", widget: "frontier-cantina" }, { surface: "scene", widget: "frontier-cantina" }],
    [{ surface: "dock" }, { surface: "dock", widget: null }],
    [{ surface: "widget", widget: "__proto__" }, { surface: "unknown", widget: null }],
    [{ surface: "scene", widget: "scouting" }, { surface: "unknown", widget: null }],
    [{ surface: "widget" }, { surface: "unknown", widget: null }],
    [null, { surface: "unknown", widget: null }],
    [{}, { surface: "unknown", widget: null }],
  ])("strictly labels %j and keeps old pages unknown", (input, expected) => expect(overlayDescriptor(input)).toEqual(expected));

  test("the real auth middleware stores only validated source metadata after token resolution", async () => {
    let middleware, connect;
    attachSocketAuth({ use: fn => { middleware = fn; }, on: (_event, fn) => { connect = fn; } }, {
      resolveOverlayToken: async () => ({ userId: "owner", label: "Owned overlay" }), secretKey: "synthetic",
    });
    const socket = { handshake: { auth: { overlayToken: "secret", surface: "widget", widget: "scouting", presenceVersion: 1, connectedAt: 1 } }, data: {}, join: jest.fn(), on: jest.fn() };
    await new Promise((resolve, reject) => middleware(socket, error => error ? reject(error) : resolve()));
    expect(socket.data.overlayPresence).toEqual({ surface: "widget", widget: "scouting" });
    connect(socket); expect(socket.data.overlayConnectedAt).toBeGreaterThan(1);
  });
  test("older cached descriptors remain unknown until refreshed", () => {
    expect(overlayHandshakeDescriptor({ surface: "all-in-one" })).toEqual({ surface: "unknown", widget: null });
    expect(overlayHandshakeDescriptor({ surface: "widget", widget: "session", presenceVersion: 0 })).toEqual({ surface: "unknown", widget: null });
    expect(overlayHandshakeDescriptor({ surface: "widget", widget: "session", presenceVersion: 1 })).toEqual({ surface: "widget", widget: "session" });
  });
});

describe("owned presence counts", () => {
  const now = Date.parse("2026-10-25T12:00:00Z");
  const source = (surface, widget, offset = 1000) => ({ id: "private-socket-id", data: { kind: "overlay", overlayToken: "secret", overlayUserId: "owner", overlayPresence: { surface, widget }, overlayConnectedAt: now - offset } });
  test("counts each kind and oldest connection without returning identities or foreign room members", () => {
    const result = summarizeOverlayPresence([
      source("widget", "scouting", 2000), source("widget", "scouting", 4000), source("dock"), source("all-in-one"), source("scene", "brb"), source("unknown"),
      { ...source("widget", "scouting"), data: { ...source("widget", "scouting").data, overlayUserId: "another-owner" } },
      { ...source("widget", "scouting"), data: { ...source("widget", "scouting").data, overlayToken: "another-token" } },
      { ...source("dock"), data: { ...source("dock").data, overlayControlOnly: true } },
    ], [{ data: { kind: "device", userId: "owner" } }], "secret", "owner", now - 3000, now);
    expect(result.totalSources).toBe(6);
    expect(result.widgets.scouting).toEqual({ count: 2, oldestConnectedAt: new Date(now - 4000).toISOString() });
    expect(result.surfaces.unknown.count).toBe(1); expect(result.scenes.brb.count).toBe(1); expect(result.agent.online).toBe(true);
    expect(result.surfaces.dock.count).toBe(1);
    expect(result.lastLiveAt).toBe(new Date(now - 3000).toISOString());
    expect(JSON.stringify(result)).not.toMatch(/private-socket-id|secret|another-owner|another-token|owner/);
  });
  test("empty/legacy timestamps and another owner's agent stay honest", () => {
    const legacy = source("unknown"); delete legacy.data.overlayConnectedAt;
    const result = summarizeOverlayPresence([legacy], [{ data: { kind: "device", userId: "another-owner" } }, { data: { kind: "overlay", userId: "owner" } }], "secret", "owner", null, now);
    expect(result.surfaces.unknown).toEqual({ count: 1, oldestConnectedAt: null });
    expect(result.agent.online).toBe(false); expect(result.lastLiveAt).toBeNull();
  });
  test("reads only the two owned in-memory rooms and fails unavailable rather than reporting zero", async () => {
    const fetchSockets = jest.fn().mockResolvedValue([]), io = { in: jest.fn(() => ({ fetchSockets })) };
    await readOverlayPresence(io, "secret", "owner");
    expect(io.in.mock.calls).toEqual([["overlay:secret"], ["user:owner"]]); expect(fetchSockets).toHaveBeenCalledTimes(2);
    await expect(readOverlayPresence(undefined, "secret", "owner")).rejects.toMatchObject({ status: 503 });
  });
  test("the recent publication clock reuses the broker cache and expires with it", () => {
    jest.useFakeTimers(); jest.setSystemTime(now);
    try {
      const broker = new LiveGameBroker(); expect(broker.latestOverlayLiveAt("owner")).toBeNull();
      broker.setLatestOverlayLive("owner", { result: "win" }); expect(broker.latestOverlayLiveAt("owner")).toBe(now);
      jest.advanceTimersByTime(24 * 60 * 60 * 1000); expect(broker.latestOverlayLiveAt("owner")).toBeNull();
      broker.clear(); expect(broker.latestOverlayLiveAt("owner")).toBeNull();
    } finally { jest.useRealTimers(); }
  });
  test("a stalled adapter settles unavailable instead of retaining an HTTP request", async () => {
    jest.useFakeTimers();
    try {
      const pending = readOverlayPresence({ in: () => ({ fetchSockets: () => new Promise(() => {}) }) }, "secret", "owner");
      const assertion = expect(pending).rejects.toMatchObject({ status: 503, code: "overlay_presence_unavailable" });
      await jest.advanceTimersByTimeAsync(1001); await assertion;
    } finally { jest.useRealTimers(); }
  });
});
