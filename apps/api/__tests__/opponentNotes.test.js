// @ts-nocheck
"use strict";

const express = require("express");
const request = require("supertest");
const { MongoMemoryServer } = require("mongodb-memory-server");

const { connect } = require("../src/db/connect");
const { OpponentsService } = require("../src/services/opponents");
const { buildOpponentsRouter } = require("../src/routes/opponents");
const { USER_SCOPED_COLLECTIONS } = require("../src/services/gdpr");

describe("per-opponent scouting notes", () => {
  let mongo;
  let db;
  let opponents;

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    db = await connect({ uri: mongo.getUri(), dbName: "opponent_notes_test" });
  });

  afterAll(async () => {
    if (db) await db.close();
    if (mongo) await mongo.stop();
  });

  beforeEach(async () => {
    await db.opponents.deleteMany({});
    await db.opponentNotes.deleteMany({});
    await db.games.deleteMany({});
    opponents = new OpponentsService(db, Buffer.alloc(32, 1));
    await db.opponents.insertOne({
      userId: "owner",
      pulseId: "pulse-1",
      pulseCharacterId: "12345",
      displayNameSample: "OldName",
      race: "T",
      gameCount: 0,
      wins: 0,
      losses: 0,
      firstSeen: new Date("2026-08-01T00:00:00Z"),
      lastSeen: new Date("2026-08-01T00:00:00Z"),
    });
    await db.games.insertOne({
      userId: "owner",
      gameId: "latest-name",
      date: new Date("2026-08-02T00:00:00Z"),
      result: "Victory",
      opponent: {
        pulseId: "pulse-1",
        pulseCharacterId: "12345",
        displayName: "CurrentName",
        race: "Terran",
      },
    });
  });

  test("persists a versioned private note and attaches it to the profile", async () => {
    const saved = await opponents.updateNotes("owner", "pulse-1", {
      notes: "  Watch for proxy barracks.  ",
      notesReadAloud: true,
    });

    expect(saved).toEqual({
      notes: "Watch for proxy barracks.",
      notesReadAloud: true,
      opponentName: "CurrentName",
      pulseCharacterId: "12345",
    });
    await expect(
      db.opponentNotes.findOne(
        { userId: "owner", pulseId: "pulse-1" },
        { projection: { _id: 0, updatedAt: 0 } },
      ),
    ).resolves.toEqual({
      userId: "owner",
      pulseId: "pulse-1",
      notes: "Watch for proxy barracks.",
      notesReadAloud: true,
      _schemaVersion: 1,
    });

    const profile = await opponents.get("owner", "pulse-1");
    expect(profile).toEqual(expect.objectContaining({
      notes: "Watch for proxy barracks.",
      notesReadAloud: true,
    }));
  });

  test("blank notes delete the row and force read-aloud off", async () => {
    await opponents.updateNotes("owner", "pulse-1", {
      notes: "Existing note",
      notesReadAloud: true,
    });
    const cleared = await opponents.updateNotes("owner", "pulse-1", {
      notes: "   ",
      notesReadAloud: true,
    });

    expect(cleared).toEqual(expect.objectContaining({
      notes: "",
      notesReadAloud: false,
    }));
    await expect(
      db.opponentNotes.findOne({ userId: "owner", pulseId: "pulse-1" }),
    ).resolves.toBeNull();
    const profile = await opponents.get("owner", "pulse-1");
    expect(profile).toEqual(expect.objectContaining({
      notes: "",
      notesReadAloud: false,
    }));
  });

  test("does not create or change notes for a non-owned opponent", async () => {
    await expect(
      opponents.updateNotes("other-user", "pulse-1", {
        notes: "Should not persist",
        notesReadAloud: true,
      }),
    ).resolves.toBeNull();
    await expect(db.opponentNotes.countDocuments({})).resolves.toBe(0);
  });

  test("registers the unique owner/opponent key and GDPR collection", async () => {
    const indexes = await db.opponentNotes.indexes();
    expect(indexes).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: { userId: 1, pulseId: 1 }, unique: true }),
    ]));
    expect(USER_SCOPED_COLLECTIONS).toContainEqual([
      "opponentNotes",
      "opponentNotes",
    ]);
  });
});

describe("PUT /opponents/:pulseId/notes", () => {
  function appWith(updateNotes, invalidateEnrichmentForOpponent = jest.fn()) {
    const app = express();
    app.use(express.json());
    const auth = (req, _res, next) => {
      req.auth = { userId: "owner" };
      next();
    };
    app.use(buildOpponentsRouter({
      opponents: { updateNotes },
      overlayLive: { invalidateEnrichmentForOpponent },
      auth,
    }));
    return { app, invalidateEnrichmentForOpponent };
  }

  test("validates both fields and the 500-character limit", async () => {
    const updateNotes = jest.fn();
    const { app } = appWith(updateNotes);

    const missingToggle = await request(app)
      .put("/opponents/pulse-1/notes")
      .send({ notes: "Scout this" });
    expect(missingToggle.status).toBe(400);
    expect(missingToggle.body.error.code).toBe("bad_request");

    const tooLong = await request(app)
      .put("/opponents/pulse-1/notes")
      .send({ notes: "x".repeat(501), notesReadAloud: false });
    expect(tooLong.status).toBe(400);
    expect(tooLong.body.error.details).toContain(
      "notes must contain at most 500 characters",
    );
    expect(updateNotes).not.toHaveBeenCalled();
  });

  test("returns public fields and invalidates only that opponent's overlay cache", async () => {
    const updateNotes = jest.fn(async () => ({
      notes: "Expect a fast third.",
      notesReadAloud: true,
      opponentName: "CurrentName",
      pulseCharacterId: "12345",
    }));
    const { app, invalidateEnrichmentForOpponent } = appWith(updateNotes);

    const res = await request(app)
      .put("/opponents/pulse-1/notes")
      .send({ notes: "Expect a fast third.", notesReadAloud: true });

    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("private, no-store");
    expect(res.body).toEqual({
      notes: "Expect a fast third.",
      notesReadAloud: true,
    });
    expect(updateNotes).toHaveBeenCalledWith("owner", "pulse-1", {
      notes: "Expect a fast third.",
      notesReadAloud: true,
    });
    expect(invalidateEnrichmentForOpponent).toHaveBeenCalledWith(
      "owner",
      "CurrentName",
      "12345",
    );
  });

  test("returns 404 for an unknown or non-owned opponent", async () => {
    const { app } = appWith(jest.fn(async () => null));
    const res = await request(app)
      .put("/opponents/not-owned/notes")
      .send({ notes: "Private", notesReadAloud: false });

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: { code: "not_found" } });
  });

  test("keeps a successful save successful if cache invalidation fails", async () => {
    const updateNotes = jest.fn(async () => ({
      notes: "Saved",
      notesReadAloud: false,
      opponentName: "CurrentName",
      pulseCharacterId: null,
    }));
    const invalidate = jest.fn(() => {
      throw new Error("cache unavailable");
    });
    const { app } = appWith(updateNotes, invalidate);

    const res = await request(app)
      .put("/opponents/pulse-1/notes")
      .send({ notes: "Saved", notesReadAloud: false });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ notes: "Saved", notesReadAloud: false });
  });
});
