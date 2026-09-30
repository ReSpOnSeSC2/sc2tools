// @ts-nocheck
"use strict";

/**
 * NO-PII scan over every public guides surface. Seeds games, samples,
 * users, community builds and a coach's note with distinctive strings —
 * uploader userIds, gameIds that embed opponent names, opponent display
 * names / battle tags / clans, pulse ids, toon handles, pulse character
 * ids, sample hashes, private build slugs, voter ids and the admin
 * editor's userId — runs the REAL nightly recompute, then GETs every
 * public endpoint and asserts none of those strings (or identity keys)
 * appear in any response body.
 *
 * Allowed on purpose: the opted-in replay sharer's handle + display
 * name ("Public Sharer") and the named community author's profile handle.
 */

const request = require("supertest");
const { createGuidesHarness } = require("./helpers/guidesHarness");
const { slimGame, sampleRow } = require("./helpers/guideStatsSeed");

jest.mock("@clerk/backend", () => require("./helpers/clerkMock")());

const USERS = 6;
const GAMES_PER_USER = 25;
const SHARER_SLUG = "public-sharer-a1b2c3d4e5";
const PUBLIC_AUTHOR = "public-author-1";

const NEEDLES = [
  "PIIUSER", "q7z", "PIIDISPLAY", "PIIOPP", "PIITAG", "PIICLAN", "PIIPULSE", "PIITOON", "PIIMINE", "PIICHAR",
  "PIIUHASH", "PIIGHASH", "PIISOURCE", "PIIREMOVED", "PIIVOTER", "PIIADMIN", "pii_email", "PIIBLANK",
  "1-S2-1-", "2-S2-1-", "3-S2-1-",
];
const BANNED_KEYS = [
  "userId", "gameId", "opponent", "userHash", "gameHash", "updatedBy", "ownerUserId", "sourceSlug",
  "toonHandle", "pulseId", "battleTag", "baseline", "baselineCandidate", "_schemaVersion",
];

const userId = (u) => `PIIUSER_q7z_${u}`;

function deepKeys(value, out = new Set()) {
  if (Array.isArray(value)) value.forEach((v) => deepKeys(v, out));
  else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      out.add(k);
      deepKeys(v, out);
    }
  }
  return out;
}

async function seedPiiGames(db) {
  await db.users.insertMany(Array.from({ length: USERS }, (_, u) => ({
    userId: userId(u),
    clerkUserId: `clerk_PIIUSER_${u}`,
    email: `pii_email_${u}@example.com`,
    displayName: u === 0 ? "Public Sharer" : `PIIDISPLAY_${u}`,
    battleTag: `PIIDISPLAY_${u}#PIITAG`,
    replaySharing: { enabled: u === 0, slug: u === 0 ? SHARER_SLUG : `private${u}-a1b2c3d4e5` },
  })));
  const games = [];
  for (let i = 0; i < USERS * GAMES_PER_USER; i += 1) {
    const u = i % USERS;
    const opp = `PIIOPP_${i}`;
    games.push(slimGame({
      userId: userId(u),
      gameId: `2026-09-01T10:00:00|${opp}|Site Delta LE|${600 + i}`,
      myToonHandle: `3-S2-1-PIIMINE${u}`,
      myName: `PIIDISPLAY_${u}`,
      result: i % 3 === 0 ? "Defeat" : "Victory",
      replayFile: { storedAt: new Date(), sizeBytes: 5, key: `replays/${userId(u)}/${i}.SC2Replay` },
      opponent: {
        displayName: opp, battleTag: `${opp}#PIITAG`, clan: "PIICLAN", pulseId: `1-S2-1-PIIPULSE${i}`,
        toonHandle: `2-S2-1-PIITOON${i}`, pulseCharacterId: `PIICHAR_${i}`, strategy: "Zerg - 12 Pool",
        mmr: 4120, leagueId: 4,
      },
    }));
  }
  for (let i = 0; i < 40; i += 1) {
    games.push(slimGame({
      userId: userId(i % 5), gameId: `2026-09-02T10:00:00|PIIOPP_robo_${i}|Site Delta LE|700`,
      myBuild: "PvZ - Robo Opener", opponent: { displayName: `PIIOPP_robo_${i}`, pulseId: `1-S2-1-PIIPULSE_r${i}` },
    }));
  }
  await db.games.insertMany(games);
}

async function seedPiiCorpus(h) {
  const { db } = h;
  await seedPiiGames(db);
  await db.guideSamples.insertMany(Array.from({ length: 60 }, (_, i) => sampleRow({
    userHash: `PIIUHASH_${i % USERS}`, gameHash: `PIIGHASH_${i}`,
    milestones: { Pylon: 18, Gateway: 41, Stargate: 181 }, army: { 360: { Oracle: 1, Adept: 4 } },
  })));
  const at = new Date("2026-09-10T00:00:00Z");
  await db.communityBuilds.insertMany([
    {
      slug: "build-anonymous", ownerUserId: userId(2), sourceSlug: "PIISOURCE_private", title: "Stargate into Glaives",
      authorName: "", publishAnonymously: true, matchup: "PvZ", removed: false, votes: 3, upvotes: ["PIIVOTER_1"],
      publishedAt: at, updatedAt: at, build: { name: "PvZ - Stargate into Glaives", slug: "PIISOURCE_legacy" },
    },
    {
      slug: "build-named", ownerUserId: PUBLIC_AUTHOR, sourceSlug: "PIISOURCE_named", title: "Public build",
      authorName: "PublicAuthor", matchup: "PvT", removed: false, votes: 1, publishedAt: at, updatedAt: at,
    },
    {
      slug: "build-removed", ownerUserId: userId(3), sourceSlug: "PIISOURCE_removed", title: "Stargate into Glaives",
      authorName: "PIIREMOVED", matchup: "PvZ", removed: true, votes: 99, publishedAt: at, updatedAt: at,
    },
    {
      slug: "build-blank-author", ownerUserId: userId(4), sourceSlug: "PIISOURCE_blank", title: "Blank author",
      authorName: "   ", matchup: "PvZ", removed: false, votes: 0, publishedAt: at, updatedAt: at,
    },
  ]);
  await db.guideNotes.insertOne({
    matchup: "PvZ", buildKey: "PvZ - Stargate into Glaives", body: "### Plan\nOpen Stargate.",
    videos: { pinned: [], hidden: [] }, updatedBy: "PIIADMIN_editor_x9", updatedAt: at, _schemaVersion: 1,
  });
  await h.guideVideos.ensureSnapshot();
  await h.services.guideStats.recompute();
}

describe("NO-PII: public guides payloads", () => {
  let h;
  const bodies = new Map();

  beforeAll(async () => {
    h = await createGuidesHarness();
    await seedPiiCorpus(h);
    const paths = [
      "/v1/guides",
      "/v1/guides/pvp", "/v1/guides/pvt", "/v1/guides/pvz", "/v1/guides/tvp", "/v1/guides/tvt",
      "/v1/guides/tvz", "/v1/guides/zvp", "/v1/guides/zvt", "/v1/guides/zvz",
      "/v1/guides/pvz?band=league:4", "/v1/guides/pvz?band=mmr:4000", "/v1/guides/pvz?era=before",
      "/v1/guides/pvz/stargate-into-glaives",
      "/v1/guides/pvz/robo-opener",
      "/v1/guides/pvz/counter/12-pool",
      "/v1/guides/pvz/counter/ling-bane-bust",
      "/v1/guides/maps/site-delta-le",
      "/v1/guides/sitemap",
      "/v1/community/sitemap",
    ];
    for (const path of paths) {
      const res = await request(h.app).get(path);
      expect([path, res.status]).toEqual([path, 200]);
      bodies.set(path, res.body);
    }
  });

  afterAll(async () => {
    if (h) await h.close();
  });

  test("the scan exercised real data (published pages, examples, links, sitemaps)", () => {
    const build = bodies.get("/v1/guides/pvz/stargate-into-glaives");
    expect(build.published).toBe(true);
    expect(build.overall.games).toBe(150);
    expect(build.examples).toEqual([expect.objectContaining({ handle: SHARER_SLUG, displayName: "Public Sharer" })]);
    expect(build.communityBuilds).toEqual([{ slug: "build-anonymous", title: "Stargate into Glaives" }]);
    expect(build.notes).toEqual({ body: "### Plan\nOpen Stargate.", updatedAt: "2026-09-10T00:00:00.000Z" });
    expect(bodies.get("/v1/guides/pvz/counter/12-pool").published).toBe(true);
    expect(bodies.get("/v1/guides/maps/site-delta-le").published).toBe(true);
    expect(bodies.get("/v1/guides/pvz/robo-opener").published).toBe(false);
    expect(bodies.get("/v1/guides/sitemap").entries.length).toBeGreaterThan(3);
    const community = bodies.get("/v1/community/sitemap");
    expect(community.builds.map((b) => b.slug).sort()).toEqual(["build-anonymous", "build-blank-author", "build-named"]);
    expect(community.profiles.map((p) => p.handle)).toEqual([PUBLIC_AUTHOR]);
  });

  test("no seeded identifier appears in any public response", () => {
    for (const [path, body] of bodies) {
      const text = JSON.stringify(body);
      const leaked = NEEDLES.filter((needle) => text.includes(needle));
      expect([path, leaked]).toEqual([path, []]);
    }
  });

  test("no identity or storage key appears in any public response", () => {
    for (const [path, body] of bodies) {
      const keys = deepKeys(body);
      const leaked = BANNED_KEYS.filter((key) => keys.has(key));
      expect([path, leaked]).toEqual([path, []]);
    }
  });
});
