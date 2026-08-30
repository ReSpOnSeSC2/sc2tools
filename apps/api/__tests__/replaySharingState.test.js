// @ts-nocheck
"use strict";

const crypto = require("crypto");
const { MongoMemoryServer } = require("mongodb-memory-server");

const { connect } = require("../src/db/connect");
const { UsersService } = require("../src/services/users");

describe("UsersService replay sharing state", () => {
  let mongo;
  let db;
  let users;

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    db = await connect({
      uri: mongo.getUri(),
      dbName: "sc2tools_test_replay_sharing_state",
    });
    users = new UsersService(db);
  });

  afterAll(async () => {
    if (db) await db.close();
    if (mongo) await mongo.stop();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  beforeEach(async () => {
    await db.users.deleteMany({});
    await db.users.insertOne({
      userId: "stable-owner-handle",
      clerkUserId: "clerk-owner",
      displayName: "Commander",
      preferredRace: "Protoss",
      battleTag: "Private#1234",
      communityProfileEnabled: true,
      preferences: { misc: { defaultTab: "trends" } },
    });
  });

  test("creates one readable canonical slug without clobbering profile state", async () => {
    await expect(users.getReplaySharing("stable-owner-handle")).resolves.toEqual({
      enabled: false,
      handle: null,
    });

    const enabled = await users.setReplaySharing("stable-owner-handle", true);
    expect(enabled).toEqual({
      enabled: true,
      handle: expect.stringMatching(/^commander-[a-f0-9]{10}$/),
    });
    expect(enabled.handle.length).toBeLessThanOrEqual(64);
    expect(enabled.handle).not.toBe("stable-owner-handle");
    await expect(users.setReplaySharing("stable-owner-handle", true))
      .resolves.toEqual(enabled);
    await expect(
      users.resolveReplaySharing(enabled.handle),
    ).resolves.toEqual({
      userId: "stable-owner-handle",
      profile: {
        handle: enabled.handle,
        displayName: "Commander",
      },
    });

    const enabledDoc = await db.users.findOne({ userId: "stable-owner-handle" });
    expect(enabledDoc).toMatchObject({
      displayName: "Commander",
      preferredRace: "Protoss",
      battleTag: "Private#1234",
      communityProfileEnabled: true,
      preferences: { misc: { defaultTab: "trends" } },
      replaySharing: {
        enabled: true,
        slug: enabled.handle,
        updatedAt: expect.any(Date),
      },
    });
    expect(enabledDoc.replaySharing.shareId).toBeUndefined();
  });

  test("retains the slug while disabled and across display-name changes", async () => {
    const enabled = await users.setReplaySharing("stable-owner-handle", true);
    await users.setReplaySharing("stable-owner-handle", false);
    await db.users.updateOne(
      { userId: "stable-owner-handle" },
      { $set: { displayName: "Renamed Player" } },
    );

    await expect(users.resolveReplaySharing(enabled.handle)).resolves.toBeNull();
    await expect(users.getReplaySharing("stable-owner-handle")).resolves.toEqual({
      enabled: false,
      handle: null,
    });
    await expect(users.setReplaySharing("stable-owner-handle", true))
      .resolves.toEqual(enabled);
    await expect(users.resolveReplaySharing(enabled.handle)).resolves.toMatchObject({
      userId: "stable-owner-handle",
      profile: { handle: enabled.handle, displayName: "Renamed Player" },
    });
  });

  test("sanitizes names, falls back to player, and retries slug collisions", async () => {
    await db.users.updateOne(
      { userId: "stable-owner-handle" },
      { $set: { displayName: "  Cömmander !!! " } },
    );
    await db.users.insertOne({
      userId: "collision-owner",
      clerkUserId: "clerk-collision-owner",
      replaySharing: { enabled: true, slug: "commander-0000000000" },
    });
    jest.spyOn(crypto, "randomBytes")
      .mockReturnValueOnce(Buffer.from("0000000000", "hex"))
      .mockReturnValueOnce(Buffer.from("1111111111", "hex"));

    await expect(users.setReplaySharing("stable-owner-handle", true)).resolves.toEqual({
      enabled: true,
      handle: "commander-1111111111",
    });

    await db.users.insertOne({
      userId: "fallback-owner",
      clerkUserId: "clerk-fallback-owner",
      displayName: "👽👽👽",
    });
    jest.spyOn(crypto, "randomBytes")
      .mockReturnValueOnce(Buffer.from("2222222222", "hex"));
    await expect(users.setReplaySharing("fallback-owner", true)).resolves.toEqual({
      enabled: true,
      handle: "player-2222222222",
    });
  });

  test("lazily migrates legacy ids and returns the canonical slug", async () => {
    const legacyShareId = "A".repeat(32);
    await db.users.updateOne(
      { userId: "stable-owner-handle" },
      {
        $set: {
          replaySharing: { enabled: true, shareId: legacyShareId },
        },
      },
    );

    const state = await users.getReplaySharing("stable-owner-handle");
    expect(state).toEqual({
      enabled: true,
      handle: expect.stringMatching(/^commander-[a-f0-9]{10}$/),
    });
    await expect(users.resolveReplaySharing(legacyShareId)).resolves.toEqual({
      userId: "stable-owner-handle",
      profile: { handle: state.handle, displayName: "Commander" },
    });
    const migrated = await db.users.findOne({ userId: "stable-owner-handle" });
    expect(migrated.replaySharing).toMatchObject({
      enabled: true,
      slug: state.handle,
      shareId: legacyShareId,
    });

    await users.setReplaySharing("stable-owner-handle", false);
    const disabled = await db.users.findOne({ userId: "stable-owner-handle" });
    expect(disabled.replaySharing.slug).toBe(state.handle);
    expect(disabled.replaySharing.shareId).toBeUndefined();
    await expect(users.resolveReplaySharing(legacyShareId)).resolves.toBeNull();
    await expect(users.setReplaySharing("stable-owner-handle", true)).resolves.toEqual({
      enabled: true,
      handle: state.handle,
    });
  });

  test("keeps malformed, missing, and private handles indistinguishable", async () => {
    await expect(users.resolveReplaySharing("bad/handle")).resolves.toBeNull();
    await expect(users.resolveReplaySharing("A".repeat(32))).resolves.toBeNull();
    await expect(
      users.resolveReplaySharing("unknown-player-0123456789"),
    ).resolves.toBeNull();
  });

  test("does not return a stale capability from an inactive legacy row", async () => {
    await db.users.updateOne(
      { userId: "stable-owner-handle" },
      {
        $set: {
          replaySharing: {
            enabled: false,
            slug: "commander-0123456789",
            shareId: "A".repeat(32),
          },
        },
      },
    );

    await expect(users.getReplaySharing("stable-owner-handle")).resolves.toEqual({
      enabled: false,
      handle: null,
    });
    await expect(
      users.resolveReplaySharing("commander-0123456789"),
    ).resolves.toBeNull();
  });

  test("rejects non-boolean updates", async () => {
    await expect(
      users.setReplaySharing("stable-owner-handle", "yes"),
    ).rejects.toMatchObject({ status: 400, code: "invalid_replay_sharing" });
    const doc = await db.users.findOne({ userId: "stable-owner-handle" });
    expect(doc.replaySharing).toBeUndefined();
  });
});
