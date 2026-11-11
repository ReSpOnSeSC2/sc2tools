// @ts-nocheck
"use strict";

const express = require("express");
const request = require("supertest");
const { MongoMemoryServer } = require("mongodb-memory-server");

const { connect } = require("../src/db/connect");
const { NotesService, MIGRATION_BATCH } = require("../src/services/notes");
const { OverlayLiveService } = require("../src/services/overlayLive");
const { buildScoutingBrief, overlayEnvelope } = require("../src/services/agentScouting");
const { ReplayLibraryService, _internals: { serializeReplayLibraryGame } } = require("../src/services/replayLibrary");
const { buildGameNotesRouter } = require("../src/routes/gameNotes");
const { parseReviewQueueQuery } = require("../src/routes/replays");
const { _internals: { publicReplayItem } } = require("../src/routes/publicReplays");
const { buildGameSnapshot } = require("../src/services/reviewRedaction");
const { prepareReplayCsv } = require("../src/services/replayCsv");
const { ownedGameNeighbors } = require("../src/services/gameNeighbors");
const { normalizeTags, streamEligible, suggestTags, enforceNoteInvariants } = require("../src/services/notesPolicy");
const { USER_SCOPED_COLLECTIONS, GDPR_CLASSIFICATION } = require("../src/services/gdpr");

const OWNER = "owner";
const MAIN = "1-S2-1-100";
const ALT = "1-S2-1-200";

// eslint-disable-next-line max-lines-per-function
describe("unified notes", () => {
  let mongo;
  let db;
  let notes;

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    db = await connect({ uri: mongo.getUri(), dbName: "notes_system_test" });
  });
  afterAll(async () => {
    if (db) await db.close();
    if (mongo) await mongo.stop();
  });
  beforeEach(async () => {
    await Promise.all(["notes", "opponentNotes", "games", "opponents"].map((name) => db[name].deleteMany({})));
    notes = new NotesService(db);
  });

  // eslint-disable-next-line max-lines-per-function
  describe("forward migration of opponent_notes", () => {
    test("moves only the owner's valid rows, keeps behaviour and leaves malformed rows untouched", async () => {
      const at = new Date("2026-09-01T00:00:00Z");
      await db.opponentNotes.insertMany([
        { userId: OWNER, pulseId: MAIN, notes: "Proxy gates every PvP", notesReadAloud: true, updatedAt: at },
        { userId: OWNER, pulseId: ALT, notes: "  ", notesReadAloud: false },
        { userId: OWNER, note: "malformed legacy row" },
        { userId: "someone-else", pulseId: MAIN, notes: "Not yours" },
      ]);
      expect(await notes.ensureMigrated(OWNER)).toBe(1);
      const moved = await db.notes.findOne({ userId: OWNER, "target.id": MAIN }, { projection: { _id: 0 } });
      expect(moved).toEqual({
        userId: OWNER, target: { kind: "opponent", id: MAIN }, text: "Proxy gates every PvP", tags: [],
        visibility: "stream", scope: "account", pinned: false, readAloud: true, migratedFrom: "opponent_notes",
        createdAt: at, updatedAt: at, _schemaVersion: 1,
      });
      // The blank row had nothing to keep; the malformed one stays for a person.
      expect(await db.opponentNotes.find({ userId: OWNER }, { projection: { _id: 0 } }).toArray()).toEqual([{ userId: OWNER, note: "malformed legacy row" }]);
      expect(await db.opponentNotes.countDocuments({ userId: "someone-else" })).toBe(1);
      expect(await db.notes.countDocuments({ userId: "someone-else" })).toBe(0);
      // Idempotent: nothing left to move, nothing duplicated.
      expect(await notes.ensureMigrated(OWNER)).toBe(0);
      expect(await db.notes.countDocuments({ userId: OWNER })).toBe(1);
    });

    test("never overwrites a note already written in the new system", async () => {
      await db.notes.insertOne({ userId: OWNER, target: { kind: "opponent", id: MAIN }, text: "Newer note", tags: ["Macro"], visibility: "private", scope: "player", pinned: true, readAloud: false });
      await db.opponentNotes.insertOne({ userId: OWNER, pulseId: MAIN, notes: "Older legacy text", notesReadAloud: true });
      await notes.ensureMigrated(OWNER);
      expect(await db.notes.findOne({ userId: OWNER, "target.id": MAIN })).toMatchObject({ text: "Newer note", visibility: "private", scope: "player" });
      expect(await db.opponentNotes.countDocuments({})).toBe(0);
    });

    test("drains a large account in bounded batches and the operator sweep covers every user", async () => {
      const rows = Array.from({ length: MIGRATION_BATCH * 2 + 50 }, (_, i) => ({ userId: OWNER, pulseId: `1-S2-1-${1000 + i}`, notes: `note ${i}` }));
      await db.opponentNotes.insertMany([...rows, { userId: "u2", pulseId: MAIN, notes: "u2 note" }]);
      const original = db.opponentNotes.find.bind(db.opponentNotes);
      const limits = [];
      const find = jest.spyOn(db.opponentNotes, "find").mockImplementation((...args) => {
        const cursor = original(...args);
        const limit = cursor.limit.bind(cursor);
        cursor.limit = (n) => { limits.push(n); return limit(n); };
        return cursor;
      });
      try {
        expect(await notes.migrateAll()).toEqual({ users: 2, notes: rows.length + 1 });
      } finally { find.mockRestore(); }
      // Every legacy read is capped at one batch; the big account took several.
      expect(limits.length).toBeGreaterThanOrEqual(5);
      expect(new Set(limits)).toEqual(new Set([MIGRATION_BATCH]));
      expect(await db.notes.countDocuments({ userId: OWNER })).toBe(rows.length);
      expect(await db.notes.countDocuments({ userId: "u2" })).toBe(1);
      expect(await db.opponentNotes.countDocuments({})).toBe(0);
      expect(await notes.migrateAll()).toEqual({ users: 0, notes: 0 });
    });

    test("the notes collection is indexed and part of export, deletion and snapshots", async () => {
      expect(await db.notes.indexes()).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: "notes_target", key: { userId: 1, "target.kind": 1, "target.id": 1 } }),
        expect.objectContaining({ name: "notes_group", key: { userId: 1, groupKey: 1 } }),
        expect.objectContaining({ name: "notes_opponent_unique", unique: true }),
      ]));
      expect(USER_SCOPED_COLLECTIONS).toContainEqual(["notes", "notes"]);
      expect(GDPR_CLASSIFICATION.NOTES).toBe("user_scoped");
    });

    test("concurrent first reads share one run", async () => {
      await db.opponentNotes.insertOne({ userId: OWNER, pulseId: MAIN, notes: "One" });
      const [a, b] = await Promise.all([notes.ensureMigrated(OWNER), notes.ensureMigrated(OWNER)]);
      expect(a + b).toBeGreaterThanOrEqual(1);
      expect(await db.notes.countDocuments({ userId: OWNER })).toBe(1);
    });
  });

  describe("visibility, tags and scope", () => {
    const opponent = { pulseId: MAIN, toonHandle: MAIN };

    test("new notes are private; Toxic forces private and silences read-aloud", async () => {
      const fresh = await notes.saveOpponentNote(OWNER, opponent, { text: "Hides tech", readAloud: false });
      expect(fresh).toMatchObject({ visibility: "private", readAloud: false, scope: "account" });
      const toxic = await notes.saveOpponentNote(OWNER, opponent, { text: "Rude in chat", visibility: "stream", tags: ["toxic", "PROXY"], readAloud: true });
      expect(toxic).toMatchObject({ visibility: "private", readAloud: false, tags: ["Toxic", "Proxy"] });
      expect(streamEligible(toxic)).toBe(false);
      const live = await notes.liveNotes(OWNER, MAIN);
      expect(live.stream).toBeNull();
      expect(live.private.note).toMatchObject({ text: "Rude in chat", visibility: "private", tags: ["Toxic", "Proxy"] });
    });

    test("only a stream note without a private tag reaches the overlay view", async () => {
      await notes.saveOpponentNote(OWNER, opponent, { text: "Fast third", visibility: "stream", readAloud: true });
      expect((await notes.liveNotes(OWNER, MAIN)).stream).toEqual({ text: "Fast third", readAloud: true });
      await notes.saveOpponentNote(OWNER, opponent, { text: "Fast third", visibility: "private", readAloud: true });
      const live = await notes.liveNotes(OWNER, MAIN);
      expect(live.stream).toBeNull();
      expect(live.private.note).toMatchObject({ text: "Fast third", readAloud: false });
    });

    test("player scope follows linked accounts by account link and group key; account scope does not", async () => {
      await db.notes.insertMany([
        { userId: OWNER, target: { kind: "opponent", id: ALT }, text: "Main plays proxy 2 gate", tags: ["Proxy"], visibility: "stream", scope: "player", pinned: false, readAloud: false, updatedAt: new Date(1) },
        { userId: OWNER, target: { kind: "opponent", id: "1-S2-1-300" }, text: "Account-only note", tags: [], visibility: "stream", scope: "account", pinned: false, readAloud: false },
        { userId: OWNER, target: { kind: "opponent", id: "1-S2-1-400" }, text: "Group note", tags: [], visibility: "private", scope: "player", groupKey: "acct:77", pinned: true, readAloud: false, updatedAt: new Date(2) },
        { userId: "intruder", target: { kind: "opponent", id: ALT }, text: "Another owner", tags: [], visibility: "stream", scope: "player" },
      ]);
      const linked = { groupKey: "acct:77", pulseIds: [MAIN, ALT, "1-S2-1-300"], identities: [{ pulseId: ALT, displayNameSample: "AltName" }] };
      const live = await notes.liveNotes(OWNER, MAIN, linked);
      // No exact note: the pinned group note leads the private list, but only
      // the stream-eligible player note reaches the overlay.
      expect(live.stream).toEqual({ text: "Main plays proxy 2 gate", readAloud: false });
      expect(live.private.note).toBeNull();
      expect(live.private.linked.map((row) => row.text)).toEqual(["Group note", "Main plays proxy 2 gate"]);
      expect(live.private.linked[1].account).toBe("AltName");
      // The exact account's own note always wins the overlay slot.
      await notes.saveOpponentNote(OWNER, opponent, { text: "Exact note", visibility: "stream", readAloud: false });
      expect((await notes.liveNotes(OWNER, MAIN, linked)).stream.text).toBe("Exact note");
      // Without links nothing follows.
      expect((await notes.forOpponent(OWNER, MAIN)).linked).toEqual([]);
    });

    test("player scope stores the resolved group key; switching back to account removes it", async () => {
      const scoped = new NotesService(db, { scoutingIdentities: { resolve: async () => ({ groupKey: "acct:9", pulseIds: [MAIN] }) } });
      expect((await scoped.saveOpponentNote(OWNER, opponent, { text: "Smurf", scope: "player" })).groupKey).toBe("acct:9");
      expect((await scoped.saveOpponentNote(OWNER, opponent, { text: "Smurf", scope: "account" })).groupKey).toBeUndefined();
      const single = new NotesService(db, { scoutingIdentities: { resolve: async () => ({ groupKey: `single:${MAIN}` }) } });
      expect((await single.saveOpponentNote(OWNER, opponent, { text: "Smurf", scope: "player" })).groupKey).toBeUndefined();
    });

    test("tag rules: canonical presets, de-duplicated, bounded and content-filtered", () => {
      expect(normalizeTags(["cheeser", "Cheeser", " all-in ", "#rival"])).toEqual({ tags: ["Cheeser", "All-in", "Rival"] });
      expect(normalizeTags(Array.from({ length: 9 }, (_, i) => `t${i}`)).error).toMatch(/at most 8/);
      expect(normalizeTags(["x".repeat(25)]).error).toMatch(/24 characters/);
      expect(normalizeTags("Proxy").error).toMatch(/array/);
      // Same leet-spelled sample the content filter's own tests use.
      expect(normalizeTags(["N1gg3r rush"]).error).toMatch(/blocked/);
      expect(enforceNoteInvariants({ visibility: "private", tags: [], readAloud: true }).readAloud).toBe(false);
    });

    test("Cheeser is suggested deterministically from at least three labelled games at 40%", () => {
      const game = (strategy) => ({ opponent: { strategy } });
      expect(suggestTags([game("Zerg - 12 Pool"), game("Hatch first"), game("Proxy 2 Gate"), game("Macro")])).toEqual(["Cheeser"]);
      expect(suggestTags([game("Zerg - 12 Pool"), game("Proxy 2 Gate")])).toEqual([]);
      expect(suggestTags([game("12 Pool"), game("Hatch"), game("Hatch"), game("Hatch")])).toEqual([]);
      expect(suggestTags([game("12 Pool"), game("Proxy"), game("Hatch")], ["Cheeser"])).toEqual([]);
    });
  });

  // eslint-disable-next-line max-lines-per-function
  describe("overlay and public surfaces never carry private notes", () => {
    test("the overlay envelope drops the private view and recent builds; the device brief keeps the exact note", () => {
      const envelope = {
        phase: "match_in_progress", gameKey: "k1", opponent: { name: "Foe", toonHandle: MAIN },
        streamerHistory: {
          oppName: "Foe", opponentIdentityMatched: true, opponentPulseId: MAIN,
          opponentNotes: { text: "Stream-safe", readAloud: false },
          privateNotes: { note: { text: "Private exact", tags: ["Toxic"], visibility: "private" }, linked: [{ text: "Alt note", tags: [], visibility: "stream" }] },
          recentBuilds: { mine: [], theirs: [] },
        },
      };
      const shared = overlayEnvelope(envelope);
      expect(shared.streamerHistory).toEqual({ oppName: "Foe", opponentIdentityMatched: true, opponentPulseId: MAIN, opponentNotes: { text: "Stream-safe", readAloud: false } });
      expect(JSON.stringify(shared)).not.toMatch(/Private exact|Alt note|Toxic/);
      // Private device brief: the exact account's own note, never an alt's.
      expect(buildScoutingBrief(envelope).note).toBe("Private exact");
      expect(buildScoutingBrief({ ...envelope, streamerHistory: { ...envelope.streamerHistory, privateNotes: { note: null, linked: [{ text: "Alt note" }] } } }).note).toBe("");
    });

    test("post-game overlay payload carries only the stream note", async () => {
      await db.opponents.insertOne({ userId: OWNER, pulseId: MAIN, displayNameSample: "Foe", gameCount: 1, wins: 1, losses: 0 });
      const overlay = new OverlayLiveService(db);
      const game = { gameId: "g1", myRace: "Protoss", result: "Victory", opponent: { pulseId: MAIN, displayName: "Foe", race: "Terran" } };
      await notes.saveOpponentNote(OWNER, { pulseId: MAIN }, { text: "Private only", visibility: "private" });
      let payload = await overlay.buildFromGame(OWNER, game);
      expect(payload.opponentNotes).toBeUndefined();
      expect(payload.privateNotes).toBeUndefined();
      expect(JSON.stringify(payload)).not.toContain("Private only");
      await notes.saveOpponentNote(OWNER, { pulseId: MAIN }, { text: "Show this", visibility: "stream", readAloud: true });
      payload = await overlay.buildFromGame(OWNER, game);
      expect(payload.opponentNotes).toEqual({ text: "Show this", readAloud: true });
      expect(payload.privateNotes).toBeUndefined();
    });

    test("live enrichment keeps both views; only the overlay copy loses the private one", async () => {
      await db.opponents.insertOne({ userId: OWNER, pulseId: MAIN, displayNameSample: "Foe", gameCount: 1, wins: 1, losses: 0 });
      await notes.saveOpponentNote(OWNER, { pulseId: MAIN }, { text: "Private scout", visibility: "private" });
      const overlay = new OverlayLiveService(db);
      const history = await overlay.buildFromOpponentName(OWNER, "Foe", "Terran", null, "Protoss", MAIN);
      expect(history.opponentNotes).toBeUndefined();
      expect(history.privateNotes.note.text).toBe("Private scout");
      const shared = overlayEnvelope({ phase: "match_started", streamerHistory: history });
      expect(JSON.stringify(shared)).not.toContain("Private scout");
    });

    test("share and review serializers are allowlists: no review state, note count or notes", () => {
      const row = {
        gameId: "g1", date: new Date("2026-10-01"), result: "Victory", map: "Alcyone LE", myRace: "Protoss", durationSec: 600,
        opponent: { displayName: "Foe", race: "Terran", mmr: 4000, strategy: "Bio" },
        review: { state: "todo", tags: ["Macro"] }, noteCount: 3, notes: [{ text: "secret note" }], buildIntent: { notes: "check-in secret" },
      };
      const owner = serializeReplayLibraryGame(row, "owner");
      expect(owner).toMatchObject({ review: { state: "todo", tags: ["Macro"] }, noteCount: 3 });
      const detector = serializeReplayLibraryGame(row, "detector");
      expect(detector).not.toHaveProperty("review");
      expect(detector).not.toHaveProperty("noteCount");
      // Even an owner row handed to the public serializer cannot leak them.
      const publicItem = publicReplayItem(owner, [], true);
      const snapshot = buildGameSnapshot(row);
      for (const out of [detector, publicItem, snapshot]) {
        expect(JSON.stringify(out)).not.toMatch(/secret|review|noteCount|"Macro"/);
      }
      expect(Object.keys(snapshot).sort()).toEqual(["askerBand", "askerMmr", "durationSec", "macroScore", "map", "matchup", "myBuild", "myRace",
        "oppRace", "oppStrategy", "opponentBand", "opponentLabel", "opponentMmr", "playedAt", "result"].sort());
    });
  });

  // eslint-disable-next-line max-lines-per-function
  describe("game notes and the review queue", () => {
    beforeEach(async () => {
      await db.games.insertMany([
        { userId: OWNER, gameId: "g1", date: new Date("2026-10-02"), durationSec: 600, map: "Alcyone LE", result: "Victory", myRace: "Protoss",
          opponent: { displayName: "Foe", race: "Terran" }, buildIntent: { notes: "Check-in note stays" } },
        { userId: OWNER, gameId: "g2", date: new Date("2026-10-01"), durationSec: 500, map: "Pylon LE", result: "Defeat", myRace: "Protoss", opponent: { displayName: "Other", race: "Zerg" } },
        { userId: OWNER, gameId: "gone", date: new Date("2026-09-01"), _deleted: true, excluded: true },
        { userId: "intruder", gameId: "g1", date: new Date("2026-10-02"), durationSec: 600 },
      ]);
    });

    test("create, list in game-time order, edit, delete for undo, with an exact note count", async () => {
      const late = await notes.createGameNote(OWNER, "g1", { text: "Lost the third", gameTimeSec: 412.34, tags: ["macro"] });
      const pinned = await notes.createGameNote(OWNER, "g1", { text: "Scout here", gameTimeSec: 95, x: 120.55, y: 33, pinned: true });
      const untimed = await notes.createGameNote(OWNER, "g1", { text: "General: practise injects" });
      expect(late).toMatchObject({ gameTimeSec: 412.3, tags: ["Macro"], visibility: "private", target: { kind: "game", id: "g1" } });
      expect(pinned).toMatchObject({ x: 120.6, y: 33, pinned: true });
      let list = await notes.listGameNotes(OWNER, "g1");
      expect(list.items.map((n) => n.text)).toEqual(["Scout here", "Lost the third", "General: practise injects"]);
      expect((await db.games.findOne({ userId: OWNER, gameId: "g1" })).noteCount).toBe(3);
      expect(await notes.updateGameNote(OWNER, "g1", late.id, { text: "Lost the third base", x: null, y: null, tags: [] })).toMatchObject({ text: "Lost the third base", tags: [] });
      const removed = await notes.deleteGameNote(OWNER, "g1", untimed.id);
      expect(removed.text).toBe("General: practise injects");
      expect((await db.games.findOne({ userId: OWNER, gameId: "g1" })).noteCount).toBe(2);
      // Undo is a re-create of the returned note.
      await notes.createGameNote(OWNER, "g1", { text: removed.text, tags: removed.tags });
      list = await notes.listGameNotes(OWNER, "g1");
      expect(list.items).toHaveLength(3);
      // Check-in notes are a separate dataset and untouched.
      expect((await db.games.findOne({ userId: OWNER, gameId: "g1" })).buildIntent).toEqual({ notes: "Check-in note stays" });
      // Another owner's same game id, a deleted game and a foreign note id are invisible.
      expect(await notes.listGameNotes("intruder", "g1")).toEqual({ items: [], limit: 200 });
      expect(await notes.listGameNotes(OWNER, "gone")).toBeNull();
      expect(await notes.updateGameNote("intruder", "g1", late.id, { text: "hijack" })).toBeNull();
      expect(await notes.deleteGameNote(OWNER, "g2", late.id)).toBeNull();
    });

    test("listing during an in-flight insert preserves the reserved note count", async () => {
      let releaseInsert;
      let insertStarted;
      let notesRead;
      const reserved = new Promise((resolve) => { insertStarted = resolve; });
      const release = new Promise((resolve) => { releaseInsert = resolve; });
      const read = new Promise((resolve) => { notesRead = resolve; });
      const insertOne = db.notes.insertOne.bind(db.notes);
      const find = db.notes.find.bind(db.notes);
      const insertSpy = jest.spyOn(db.notes, "insertOne").mockImplementationOnce(async (...args) => {
        insertStarted();
        await release;
        return insertOne(...args);
      });
      const readSpy = jest.spyOn(db.notes, "find").mockImplementationOnce((...args) => {
        const cursor = find(...args);
        const toArray = cursor.toArray.bind(cursor);
        cursor.toArray = async () => {
          const rows = await toArray();
          notesRead();
          return rows;
        };
        return cursor;
      });
      try {
        const create = notes.createGameNote(OWNER, "g1", { text: "Save in flight" });
        await reserved;
        const list = notes.listGameNotes(OWNER, "g1");
        await read;
        releaseInsert();
        await Promise.all([create, list]);
        expect((await db.games.findOne({ userId: OWNER, gameId: "g1" })).noteCount).toBe(1);
      } finally {
        releaseInsert();
        insertSpy.mockRestore();
        readSpy.mockRestore();
      }
    });

    test("validation: time inside the game, map point pairs, text and the 200-note cap", async () => {
      await expect(notes.createGameNote(OWNER, "g1", { text: "late", gameTimeSec: 900 })).rejects.toMatchObject({ status: 400 });
      await expect(notes.createGameNote(OWNER, "g1", { text: "half point", x: 10 })).rejects.toMatchObject({ status: 400 });
      await expect(notes.createGameNote(OWNER, "g1", { text: "  " })).rejects.toMatchObject({ status: 400 });
      await expect(notes.createGameNote(OWNER, "g1", { text: "x".repeat(501) })).rejects.toMatchObject({ status: 400 });
      expect(await notes.createGameNote(OWNER, "missing", { text: "no game" })).toBeNull();
      await db.games.updateOne({ userId: OWNER, gameId: "g2" }, { $set: { noteCount: 200 } });
      await expect(notes.createGameNote(OWNER, "g2", { text: "one too many" })).rejects.toMatchObject({ status: 409, code: "game_notes_limit" });
      expect(await db.notes.countDocuments({ "target.id": "g2" })).toBe(0);
      // A listing heals a drifted counter.
      await notes.listGameNotes(OWNER, "g2");
      expect((await db.games.findOne({ userId: OWNER, gameId: "g2" })).noteCount).toBeUndefined();
    });

    test("review state and tags, then filters, tag search and note-text search in the owner library only", async () => {
      expect(await notes.setReview(OWNER, "g1", { state: "todo", tags: ["supply blocks", "Macro"] })).toMatchObject({ review: { state: "todo", tags: ["supply blocks", "Macro"] } });
      await expect(notes.setReview(OWNER, "g1", { state: "later" })).rejects.toMatchObject({ status: 400 });
      await expect(notes.setReview(OWNER, "g1", { state: "done", tags: ["a", "b", "c", "d", "e", "f"] })).rejects.toMatchObject({ status: 400 });
      await notes.createGameNote(OWNER, "g2", { text: "Remember the banshee timing", gameTimeSec: 300 });
      expect(await notes.reviewTags(OWNER)).toEqual(["Macro", "supply blocks"]);
      const library = new ReplayLibraryService(db);
      const ids = async (opts) => (await library.list(OWNER, opts)).items.map((item) => item.gameId);
      expect(await ids({ review: "todo" })).toEqual(["g1"]);
      expect(await ids({ reviewTag: "macro" })).toEqual(["g1"]);
      expect(await ids({ hasNotes: true })).toEqual(["g2"]);
      expect(await ids({ search: "banshee", searchNotes: true })).toEqual(["g2"]);
      expect(await ids({ search: "banshee" })).toEqual([]);
      const owned = (await library.list(OWNER, {})).items.find((item) => item.gameId === "g1");
      expect(owned).toMatchObject({ review: { state: "todo", tags: ["supply blocks", "Macro"] }, noteCount: 0 });
      // The public (detector) view ignores every private filter and field.
      const publicIds = (await library.list(OWNER, { view: "detector", review: "todo", hasNotes: true, search: "banshee", searchNotes: true })).items;
      expect(publicIds).toEqual([]);
      const publicAll = (await library.list(OWNER, { view: "detector", review: "todo" })).items;
      expect(publicAll.map((item) => item.gameId).sort()).toEqual(["g1", "g2"]);
      expect(JSON.stringify(publicAll)).not.toMatch(/review|noteCount/);
      // The CSV export and the game page's Older/Newer follow the same queue.
      const prepared = await prepareReplayCsv(db.games, OWNER, {}, { review: "todo" });
      let text = "";
      for await (const chunk of prepared.stream) text += chunk;
      expect(text).toContain("Alcyone LE");
      expect(text).not.toContain("Pylon LE");
      expect(await ownedGameNeighbors(db, OWNER, "g2", { search: "banshee" })).toMatchObject({ prev: null, next: null });
      await notes.createGameNote(OWNER, "g1", { text: "banshee again" });
      expect((await ownedGameNeighbors(db, OWNER, "g2", { search: "banshee" })).next?.gameId).toBe("g1");
      expect((await ownedGameNeighbors(db, OWNER, "g2", { review: "todo" })).next?.gameId).toBe("g1");
      expect(await notes.setReview(OWNER, "g1", { state: null, tags: [] })).toEqual({ review: null });
      expect((await db.games.findOne({ userId: OWNER, gameId: "g1" })).review).toBeUndefined();
      expect(await notes.setReview(OWNER, "gone", { state: "todo" })).toBeNull();
    });

    test("a history wipe removes notes of games that no longer exist", async () => {
      await notes.createGameNote(OWNER, "g1", { text: "keep" });
      await notes.createGameNote(OWNER, "g2", { text: "wiped" });
      await db.notes.insertOne({ userId: OWNER, target: { kind: "game", id: "gone" }, text: "orphan" });
      await db.notes.insertOne({ userId: OWNER, target: { kind: "opponent", id: MAIN }, text: "opponent note stays" });
      await db.games.deleteOne({ userId: OWNER, gameId: "g2" });
      expect(await notes.deleteForMissingGames(OWNER)).toBe(2);
      expect((await db.notes.find({ userId: OWNER }).toArray()).map((n) => n.text).sort()).toEqual(["keep", "opponent note stays"]);
    });
  });

  describe("routes", () => {
    function app(userId = OWNER) {
      const server = express();
      server.use(express.json());
      server.use(buildGameNotesRouter({ auth: (req, _res, next) => { req.auth = { userId }; next(); }, notes }));
      server.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: { code: err.code || "internal" } }));
      return server;
    }

    test("owner-only, no-store CRUD and review toggle", async () => {
      await db.games.insertOne({ userId: OWNER, gameId: "g1", date: new Date(), durationSec: 300 });
      const created = await request(app()).post("/games/g1/notes").send({ text: "At 4:12", gameTimeSec: 252 });
      expect(created.status).toBe(201);
      expect(created.headers["cache-control"]).toBe("private, no-store");
      const listed = await request(app()).get("/games/g1/notes");
      expect(listed.body.items.map((n) => n.text)).toEqual(["At 4:12"]);
      expect((await request(app("intruder")).get("/games/g1/notes")).status).toBe(404);
      expect((await request(app()).patch(`/games/g1/notes/${created.body.id}`).send({ pinned: "yes" })).status).toBe(400);
      expect((await request(app()).delete(`/games/g1/notes/${created.body.id}`)).body.text).toBe("At 4:12");
      expect((await request(app()).put("/games/g1/review").send({ state: "done", tags: ["Builds"] })).body).toMatchObject({ review: { state: "done", tags: ["Builds"] } });
      expect((await request(app()).put("/games/g1/review").send({ state: "todo", extra: 1 })).status).toBe(400);
      expect((await request(app()).get("/review-queue/tags")).body).toEqual({ tags: ["Builds"] });
    });

    test("the review queue query is an allowlist", () => {
      expect(parseReviewQueueQuery({ review: "todo", review_tag: " Macro ", notes: "has", other: "x" })).toEqual({ review: "todo", reviewTag: "Macro", hasNotes: true });
      expect(parseReviewQueueQuery({ review: "{$ne:1}", notes: "1", review_tag: "x".repeat(60) })).toEqual({});
    });
  });
});
