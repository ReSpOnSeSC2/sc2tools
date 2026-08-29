// @ts-nocheck
"use strict";

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

  test("is default-off, opaque, rotatable, and never clobbers profile state", async () => {
    await expect(users.getReplaySharing("stable-owner-handle")).resolves.toEqual({
      enabled: false,
      handle: null,
    });

    const enabled = await users.setReplaySharing("stable-owner-handle", true);
    expect(enabled).toEqual({
      enabled: true,
      handle: expect.stringMatching(/^[A-Za-z0-9_-]{32}$/),
    });
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
        shareId: enabled.handle,
        updatedAt: expect.any(Date),
      },
    });

    await users.setReplaySharing("stable-owner-handle", false);
    await expect(
      users.resolveReplaySharing(enabled.handle),
    ).resolves.toBeNull();
    await expect(users.getReplaySharing("stable-owner-handle")).resolves.toEqual({
      enabled: false,
      handle: null,
    });

    const reenabled = await users.setReplaySharing("stable-owner-handle", true);
    expect(reenabled.handle).not.toBe(enabled.handle);
    await expect(users.resolveReplaySharing(enabled.handle)).resolves.toBeNull();
    await expect(users.resolveReplaySharing(reenabled.handle)).resolves.toMatchObject({
      userId: "stable-owner-handle",
      profile: { handle: reenabled.handle },
    });
  });

  test("keeps malformed, missing, and private handles indistinguishable", async () => {
    await expect(users.resolveReplaySharing("bad/handle")).resolves.toBeNull();
    await expect(users.resolveReplaySharing("A".repeat(32))).resolves.toBeNull();
    await expect(
      users.resolveReplaySharing("stable-owner-handle"),
    ).resolves.toBeNull();
  });

  test("does not return a stale capability from an inactive legacy row", async () => {
    await db.users.updateOne(
      { userId: "stable-owner-handle" },
      {
        $set: {
          replaySharing: {
            enabled: false,
            shareId: "A".repeat(32),
          },
        },
      },
    );

    await expect(users.getReplaySharing("stable-owner-handle")).resolves.toEqual({
      enabled: false,
      handle: null,
    });
  });

  test("rejects non-boolean updates", async () => {
    await expect(
      users.setReplaySharing("stable-owner-handle", "yes"),
    ).rejects.toMatchObject({ status: 400, code: "invalid_replay_sharing" });
    const doc = await db.users.findOne({ userId: "stable-owner-handle" });
    expect(doc.replaySharing).toBeUndefined();
  });
});
