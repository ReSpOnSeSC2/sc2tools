// @ts-nocheck
"use strict";

/**
 * services/guideNotes.js — coach's notes CRUD: AJV validation, merge
 * saves, the internal ``updatedBy`` never leaving the service, the unique
 * {matchup, buildKey} index, and the GDPR scrub of ``updatedBy``.
 */

const { GuideNotesService, normalizeBody } = require("../src/services/guideNotes");
const { GUIDE_NOTE_MAX_CHARS } = require("../src/config/guides");
const { createGuidesHarness, GLAIVES } = require("./helpers/guidesHarness");

jest.mock("@clerk/backend", () => require("./helpers/clerkMock")());

const VIDEO_A = "YcTMc_Ee11w";
const VIDEO_B = "RYjRs_no8t4";

describe("GuideNotesService", () => {
  let h; let notes; let now;

  beforeAll(async () => {
    h = await createGuidesHarness();
    now = Date.parse("2026-09-20T10:00:00Z");
    notes = new GuideNotesService(h.db, { now: () => now });
  });

  beforeEach(async () => {
    await h.db.guideNotes.deleteMany({});
  });

  afterAll(async () => {
    if (h) await h.close();
  });

  test("guide_notes has a unique {matchup, buildKey} index", async () => {
    const indexes = await h.db.guideNotes.indexes();
    expect(indexes).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: { matchup: 1, buildKey: 1 }, unique: true }),
    ]));
  });

  test("save creates a note with defaults; the editor id stays internal", async () => {
    const note = await notes.save("PvZ", GLAIVES, { body: "### Plan\r\nGo\u0000." }, "u_editor");
    expect(note).toEqual({
      matchup: "PvZ", buildKey: GLAIVES, buildSlug: "stargate-into-glaives", body: "### Plan\nGo.",
      videos: { pinned: [], hidden: [] }, updatedAt: new Date(now),
    });
    const stored = await h.db.guideNotes.findOne({ matchup: "PvZ", buildKey: GLAIVES });
    expect(stored).toMatchObject({ updatedBy: "u_editor", _schemaVersion: 1 });
    expect(await notes.find("PvZ", GLAIVES)).not.toHaveProperty("updatedBy");
    expect((await notes.list())[0]).not.toHaveProperty("updatedBy");
  });

  test("saves merge: a body-only save keeps the videos, a videos-only save keeps the body", async () => {
    await notes.save("PvZ", GLAIVES, { body: "first", videos: { pinned: [VIDEO_A], hidden: [VIDEO_B] } }, "u_a");
    now += 1000;
    const bodyOnly = await notes.save("PvZ", GLAIVES, { body: "second" }, "u_b");
    expect(bodyOnly).toMatchObject({ body: "second", videos: { pinned: [VIDEO_A], hidden: [VIDEO_B] } });
    const videosOnly = await notes.save("PvZ", GLAIVES, { videos: { pinned: [] } }, "u_c");
    expect(videosOnly).toMatchObject({ body: "second", videos: { pinned: [], hidden: [] } });
    expect(await h.db.guideNotes.countDocuments({})).toBe(1);
    const firstVideosOnly = await notes.save("PvZ", "PvZ - Robo Opener", { videos: { hidden: [VIDEO_A] } }, null);
    expect(firstVideosOnly).toMatchObject({ body: "", videos: { pinned: [], hidden: [VIDEO_A] } });
  });

  test.each([
    ["an empty object", {}],
    ["a non-object", "hello"],
    ["an array", [{ body: "x" }]],
    ["an over-long body", { body: "x".repeat(GUIDE_NOTE_MAX_CHARS + 1) }],
    ["a non-string body", { body: 42 }],
    ["an unknown field", { body: "x", updatedBy: "someone" }],
    ["a bad video id", { videos: { pinned: ["not-an-id"] } }],
    ["too many pins", { videos: { pinned: ["aaaaaaaaaaa", "bbbbbbbbbbb", "ccccccccccc", "ddddddddddd"] } }],
    ["too many hidden", { videos: { hidden: Array.from({ length: 21 }, (_, i) => `v${String(i).padStart(10, "0")}`) } }],
    ["duplicate pins", { videos: { pinned: [VIDEO_A, VIDEO_A] } }],
    ["pinned and hidden at once", { videos: { pinned: [VIDEO_A], hidden: [VIDEO_A] } }],
    ["an unknown videos field", { videos: { featured: [VIDEO_A] } }],
  ])("rejects %s with a coded 400 and writes nothing", async (_label, input) => {
    await expect(notes.save("PvZ", GLAIVES, input, "u_a")).rejects.toMatchObject({ status: 400, code: "invalid_note" });
    expect(await h.db.guideNotes.countDocuments({})).toBe(0);
  });

  test("a body of exactly the cap is accepted", async () => {
    const note = await notes.save("PvZ", GLAIVES, { body: "y".repeat(GUIDE_NOTE_MAX_CHARS) }, "u_a");
    expect(note.body).toHaveLength(GUIDE_NOTE_MAX_CHARS);
  });

  test("list is ordered and skips notes whose build left the catalog; remove reports what it did", async () => {
    await notes.save("PvZ", GLAIVES, { body: "g" }, "u_a");
    await notes.save("PvT", "PvT - DT Drop", { body: "d" }, "u_a");
    await h.db.guideNotes.insertOne({ matchup: "PvZ", buildKey: "PvZ - Renamed Away", body: "x", updatedAt: new Date(now) });
    expect((await notes.list()).map((n) => [n.matchup, n.buildSlug])).toEqual([
      ["PvT", "dt-drop"], ["PvZ", "stargate-into-glaives"],
    ]);
    expect(await notes.remove("PvZ", GLAIVES)).toBe(true);
    expect(await notes.remove("PvZ", GLAIVES)).toBe(false);
    expect(await notes.find("PvZ", GLAIVES)).toBeNull();
  });

  test("normalizeBody keeps tabs and newlines, drops other control characters", () => {
    expect(normalizeBody("a\r\nb\rc\td\u0007\u001b\u007f")).toBe("a\nb\nc\td");
  });

  test("GDPR delete scrubs the editor id and keeps the note", async () => {
    const editor = await h.seedUser("editor");
    await notes.save("PvZ", GLAIVES, { body: "keep me" }, editor);
    await notes.save("PvT", "PvT - DT Drop", { body: "someone else" }, "u_other_admin");
    const counts = await h.services.gdpr.deleteAll(editor);
    expect(counts.guideNotesScrubbed).toBe(1);
    const scrubbed = await h.db.guideNotes.findOne({ matchup: "PvZ", buildKey: GLAIVES });
    expect(scrubbed).toMatchObject({ body: "keep me", updatedBy: null });
    const other = await h.db.guideNotes.findOne({ matchup: "PvT" });
    expect(other.updatedBy).toBe("u_other_admin");
  });
});
