// @ts-nocheck
"use strict";

/**
 * GDPR paths scrub a sharer's example replays out of the published
 * guide_stats build docs (services/gdpr.js ``_scrubGuideExamples``): an
 * account delete, a ranged or full history wipe and a snapshot restore
 * each pull every example stored under the user's replay-sharing handle
 * and leave other sharers' examples alone. The corpus is the real nightly
 * recompute over seeded games (helpers/guidesHarness.js).
 */

const { createGuidesHarness, seedGuideCorpus, SHARER_SLUG, GLAIVES } = require("./helpers/guidesHarness");

jest.mock("@clerk/backend", () => require("./helpers/clerkMock")());

const SHARER_ID = "gl-0";
const OTHER_SLUG = "other-sharer-0a1b2c3d4e";
const GLAIVES_DOC = { kind: "build", era: "after", matchup: "PvZ", buildKey: GLAIVES };
const OTHER_EXAMPLE = {
  handle: OTHER_SLUG, displayName: "Other Sharer", result: "Victory",
  map: "Site Delta LE", durationSec: 700, playedAt: new Date("2026-09-01T12:00:00Z"),
};

describe("GDPR scrubs guide example replays", () => {
  let h;

  beforeEach(async () => {
    h = await createGuidesHarness();
    await seedGuideCorpus(h);
    await h.db.guideStats.updateOne(GLAIVES_DOC, { $push: { examples: OTHER_EXAMPLE } });
    // The harness has no replay object store, so the GDPR paths would 503 on
    // the stored-replay marker. The example is already published by the
    // recompute above; only the marker on the slim row goes.
    await h.db.games.updateMany({ userId: SHARER_ID }, { $unset: { replayFile: "" } });
  });

  afterEach(async () => {
    if (h) await h.close();
  });

  const handles = async () => {
    const doc = await h.db.guideStats.findOne(GLAIVES_DOC);
    return (doc.examples || []).map((ex) => ex.handle);
  };

  test("the corpus publishes the sharer's example next to another sharer's", async () => {
    expect(await handles()).toEqual([SHARER_SLUG, OTHER_SLUG]);
  });

  test("deleteAll pulls the deleted user's examples and reports the scrub", async () => {
    const counts = await h.services.gdpr.deleteAll(SHARER_ID);
    expect(counts.guideExamplesScrubbed).toBe(1);
    expect(await handles()).toEqual([OTHER_SLUG]);
    const stored = JSON.stringify(await h.db.guideStats.find({}).toArray());
    expect(stored).not.toContain(SHARER_SLUG);
    expect(stored).not.toContain("Sharer One");
  });

  test("a ranged history wipe pulls the sharer's examples while the account keeps sharing", async () => {
    await h.services.gdpr.wipeGames(SHARER_ID, { since: new Date(Date.now() - 60_000) });
    expect(await h.db.users.countDocuments({ userId: SHARER_ID, "replaySharing.enabled": true })).toBe(1);
    expect(await handles()).toEqual([OTHER_SLUG]);
  });

  test("a full history wipe pulls the sharer's examples", async () => {
    await h.services.gdpr.wipeGames(SHARER_ID);
    expect(await handles()).toEqual([OTHER_SLUG]);
  });

  test("a snapshot restore pulls the sharer's examples", async () => {
    const { id } = await h.services.gdpr.snapshot(SHARER_ID);
    await h.services.gdpr.restoreSnapshot(SHARER_ID, id);
    expect(await handles()).toEqual([OTHER_SLUG]);
  });

  test("a user without replay sharing scrubs nothing", async () => {
    const userId = await h.seedUser("no-share");
    const counts = await h.services.gdpr.deleteAll(userId);
    expect(counts.guideExamplesScrubbed).toBe(0);
    expect(await handles()).toEqual([SHARER_SLUG, OTHER_SLUG]);
  });
});
