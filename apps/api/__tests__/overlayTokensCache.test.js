// @ts-nocheck
"use strict";

const {
  OverlayTokensService,
  LAST_SEEN_WRITE_MAX,
  RESOLVE_INFLIGHT_MAX,
} = require("../src/services/overlayTokens");

describe("OverlayTokensService resolve burst control", () => {
  test("coalesces repeated browser-surface authentication reads and heartbeats", async () => {
    const row = {
      token: "overlay-secret",
      userId: "user-1",
      label: "Live",
      revokedAt: null,
      enabledWidgets: ["multichat"],
    };
    const collection = {
      findOne: jest.fn(async (query) =>
        query.token === row.token && row.revokedAt === null ? { ...row } : null,
      ),
      updateOne: jest.fn(async (query, update) => {
        if (query.token === row.token && update.$set?.revokedAt) {
          row.revokedAt = update.$set.revokedAt;
        }
        return { matchedCount: 1, modifiedCount: 1 };
      }),
    };
    const service = new OverlayTokensService({ overlayTokens: collection });

    const values = await Promise.all([
      service.resolve(row.token),
      service.resolve(row.token),
      service.resolve(row.token),
      service.resolve(row.token),
    ]);
    await Promise.resolve();

    expect(values).toEqual(Array(4).fill({
      userId: "user-1",
      label: "Live",
      enabledWidgets: ["multichat"],
    }));
    expect(collection.findOne).toHaveBeenCalledTimes(1);
    expect(
      collection.updateOne.mock.calls.filter(
        ([, update]) => update.$set?.lastSeenAt,
      ),
    ).toHaveLength(1);

    await expect(service.revoke("user-1", row.token)).resolves.toBe(true);
    await expect(service.resolve(row.token)).resolves.toBeNull();
    expect(collection.findOne).toHaveBeenCalledTimes(2);
  });

  test("bounds distinct in-flight token lookups while identical lookups coalesce", async () => {
    const releases = [];
    const collection = {
      findOne: jest.fn(() => new Promise((resolve) => releases.push(resolve))),
      updateOne: jest.fn(async () => ({ matchedCount: 1, modifiedCount: 1 })),
    };
    const service = new OverlayTokensService({ overlayTokens: collection });
    const pending = Array.from({ length: RESOLVE_INFLIGHT_MAX }, (_, index) =>
      service.resolve(`token-${index}`));

    const duplicate = service.resolve("token-0");
    await expect(service.resolve("overflow-token")).rejects.toMatchObject({
      code: "overlay_token_resolve_busy",
      status: 503,
    });
    expect(collection.findOne).toHaveBeenCalledTimes(RESOLVE_INFLIGHT_MAX);
    for (const release of releases) release(null);
    await expect(Promise.all(pending)).resolves.toEqual(
      Array(RESOLVE_INFLIGHT_MAX).fill(null),
    );
    await expect(duplicate).resolves.toBeNull();
  });

  test("bounds heartbeat keys independently from the short resolve cache", () => {
    const collection = {
      findOne: jest.fn(),
      updateOne: jest.fn(async () => ({ matchedCount: 1, modifiedCount: 1 })),
    };
    const service = new OverlayTokensService({ overlayTokens: collection });
    for (let index = 0; index < LAST_SEEN_WRITE_MAX + 40; index += 1) {
      service._touchLastSeen(`token-${index}`, `hash-${index}`);
    }
    expect(service.lastSeenWrites.size).toBe(LAST_SEEN_WRITE_MAX);
    expect(service.capacitySnapshot().lastSeenWriteEntries)
      .toBe(LAST_SEEN_WRITE_MAX);
  });

  test("a revoke invalidates a Mongo lookup that was already in flight", async () => {
    let releaseLookup;
    const collection = {
      findOne: jest.fn(() => new Promise((resolve) => {
        releaseLookup = resolve;
      })),
      updateOne: jest.fn(async () => ({ matchedCount: 1, modifiedCount: 1 })),
    };
    const service = new OverlayTokensService({ overlayTokens: collection });
    const pending = service.resolve("revoked-during-read");
    await Promise.resolve();
    await service.revoke("user-1", "revoked-during-read");
    releaseLookup({
      token: "revoked-during-read",
      userId: "user-1",
      label: "Old",
      enabledWidgets: [],
    });
    await expect(pending).resolves.toBeNull();
    expect(service.capacitySnapshot().resolveCacheEntries).toBe(0);
  });
});
