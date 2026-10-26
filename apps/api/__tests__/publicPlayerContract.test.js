// @ts-nocheck
"use strict";
const { PublicPlayerService, publicBuilds } = require("../src/services/publicPlayer");
const { PublicPlayerPreferencesService } = require("../src/services/publicPlayerPreferences");
const { publicPlayerSettings, SECTION_KEYS, validPlayerSlug } = require("../src/util/publicPlayerConfig");
const { recentForm } = require("../src/services/publicPlayerAggregates");
const ID = "11111111-1111-4111-8111-111111111111";
const SLUG = "sample-player-0123456789";
const OPPONENT = "PrivateOpponent#1234";
const author = { displayName: "Public name", totalBuilds: 1, primaryRace: "Protoss", joinedAt: new Date("2026-01-01"),
  topBuild: { slug: "public-build", title: "Public build", ownerUserId: ID },
  builds: [{ slug: "public-build", title: "Public build", authorName: "Public name", ownerUserId: ID, build: { secret: "PRIVATE_BUILD_SNAPSHOT" } }] };
const flags = Object.fromEntries(SECTION_KEYS.map(key => [key, false]));
const row = (result, date, extra = {}) => ({ result, date: new Date(date), my_race: "Protoss", opp_race: "Terran", opponent: OPPONENT,
  pulseId: "PRIVATE_PULSE", toon: "PRIVATE_TOON", map: "PRIVATE_MAP", gameId: "PRIVATE_GAME", ...extra });

function harness({ config = { enabled: true, revision: 0, ...flags }, sharing = false, named = true, slug = SLUG } = {}) {
  let user = { userId: ID, displayName: "Private account name", email: "private@example.invalid", clerkUserId: "PRIVATE_CLERK",
    replaySharing: { enabled: sharing, ...(slug ? { slug } : {}) }, ...(config === undefined ? {} : { publicProfile: config }) };
  // Explicit undefined is hard to pass through a destructured default; callers
  // can delete the old preference to model a truly unconfigured legacy user.
  const community = { getAuthor: jest.fn(async () => named ? structuredClone(author) : null) };
  const summary = { totals: { total: 3, wins: 2, losses: 1 }, byMatchup: { "vs T": { total: 3, wins: 2, losses: 1 } },
    recent: [row("win", "2026-10-25"), row("victory", "2026-10-24"), row("loss", "2026-10-23")] };
  let mutations = 0;
  const db = { users: {
    find: jest.fn(query => ({ limit: () => ({ toArray: async () => user && query.userId.$in.includes(ID) ? [structuredClone(user)] : [] }) })),
    findOne: jest.fn(async query => {
      if (!user) return null;
      if (query.userId && query.userId !== user.userId) return null;
      if (query["replaySharing.slug"] && query["replaySharing.slug"] !== user.replaySharing?.slug) return null;
      if (query.$or && !query.$or.some(part => part.userId === user.userId || part["replaySharing.slug"] === user.replaySharing?.slug)) return null;
      return structuredClone(user);
    }),
    updateOne: jest.fn(async (query, change) => {
      if (!user || query.userId !== user.userId) return { matchedCount: 0 };
      if (query.publicProfile?.$exists === false && Object.hasOwn(user, "publicProfile")) return { matchedCount: 0 };
      if (query.$or && validPlayerSlug(user.replaySharing?.slug)) return { matchedCount: 0 };
      for (const part of query.$and || []) {
        if (part["publicProfile.revision"] !== undefined && part["publicProfile.revision"] !== user.publicProfile?.revision) return { matchedCount: 0 };
        if (part["replaySharing.slug"]?.$exists === false && user.replaySharing?.slug !== undefined) return { matchedCount: 0 };
        if (typeof part["replaySharing.slug"] === "string" && part["replaySharing.slug"] !== user.replaySharing?.slug) return { matchedCount: 0 };
        if (part["replaySharing.enabled"]?.$ne === true && user.replaySharing?.enabled === true) return { matchedCount: 0 };
      }
      for (const [key, value] of Object.entries(change.$set || {})) {
        if (key === "replaySharing.slug") user.replaySharing.slug = value;
        else user[key] = structuredClone(value);
      }
      mutations += 1;
      return { matchedCount: 1, modifiedCount: 1 };
    }),
  }, games: { aggregate: jest.fn(() => ({ toArray: async () => [{ mmr: [{ _id: new Date("2026-10-19"), mmr: 4100, games: 10 }], maps: [{ _id: "Public Map", games: 10, wins: 7, losses: 3 }] }] })) },
  playerChannels: { find: jest.fn(() => ({ limit: () => ({ toArray: async () => [{ channels: { twitch: "https://www.twitch.tv/example", youtube: null }, token: "PRIVATE_CHANNEL_TOKEN" }] }) })) } };
  const opts = { community, aggregations: { summary: jest.fn(async () => summary) }, builds: { list: jest.fn(async () => [{ name: "PvT - DT Rush", total: 3, wins: 2, losses: 1 }]) },
    profile: { _mainRace: jest.fn(async () => "Protoss"), reviewerReputation: null }, replayLibrary: { list: jest.fn(async () => ({ summary: { total: 12 }, items: [{ private: OPPONENT }] })) } };
  const players = new PublicPlayerService(db, opts);
  const preferences = new PublicPlayerPreferencesService(db, { community, resolveLegacy: id => players.resolve(id) });
  return { db, community, summary, opts, players, preferences, state: () => user, mutations: () => mutations,
    legacy: () => { delete user.publicProfile; }, erase: () => { user = null; } };
}

// eslint-disable-next-line max-lines-per-function -- Registers independent privacy cases; each case and runtime helper stays bounded.
describe("public player consent and response boundary", () => {
  test("default new sections are off for a legacy named publication", async () => {
    const h = harness(); h.legacy();
    const result = await h.players.get(SLUG);
    expect(result.profile.sections).toEqual(flags);
    expect(result.profile.replayArchive).toBeNull();
    for (const key of ["recentForm", "currentStreak", "lastPlayedAt", "maps", "seasons", "mmrHistory", "channels"]) expect(result.profile).not.toHaveProperty(key);
    expect(h.db.games.aggregate).not.toHaveBeenCalled();
    expect(h.db.playerChannels.find).not.toHaveBeenCalled();
    expect(h.opts.replayLibrary.list).not.toHaveBeenCalled();
  });

  test("explicit Profile OFF overrides named published builds, including a warm cache", async () => {
    const h = harness();
    expect((await h.players.get(SLUG)).profile).toBeTruthy();
    h.state().publicProfile.enabled = false;
    expect(await h.players.get(SLUG)).toBeNull();
    expect(await h.players.authorProfile(ID)).toBeNull();
    expect(await h.players.identity(ID)).toBeNull();
  });

  test("archive-only response and identity omit every profile capability", async () => {
    const h = harness({ config: { enabled: false, revision: 0, ...flags }, sharing: true });
    expect(await h.players.get(SLUG)).toEqual({ profile: null, archiveOnly: true, handle: SLUG, displayName: "Private account name" });
    expect(await h.players.identity(ID)).toEqual({ displayName: "Private account name" });
    expect(h.opts.aggregations.summary).not.toHaveBeenCalled();
    expect(h.db.users.updateOne).not.toHaveBeenCalled();
  });

  test("profile-only never acquires an archive capability even when its section is checked", async () => {
    const h = harness({ config: { enabled: true, revision: 0, ...flags, showReplays: true }, sharing: false });
    expect((await h.players.get(SLUG)).profile.replayArchive).toBeNull();
    expect(h.opts.replayLibrary.list).not.toHaveBeenCalled();
  });

  test("each independently opted-in section returns only its shaped values", async () => {
    const h = harness({ config: { enabled: true, revision: 0, ...flags, showRecentForm: true, showMaps: true, showMmrHistory: true, showChannels: true, showReplays: true }, sharing: true });
    const result = await h.players.get(SLUG);
    expect(result.profile.recentForm).toEqual(h.summary.recent.map(item => ({ result: item.result === "loss" ? "L" : "W", matchup: "PvT", date: item.date.toISOString() })));
    expect(result.profile.currentStreak).toEqual({ kind: "W", count: 2 });
    expect(result.profile.replayArchive).toEqual({ handle: SLUG, total: 12 });
    expect(result.profile.channels).toEqual([{ platform: "twitch", url: "https://www.twitch.tv/example" }]);
    const text = JSON.stringify(result);
    for (const secret of [ID, OPPONENT, "PRIVATE_PULSE", "PRIVATE_TOON", "PRIVATE_MAP", "PRIVATE_GAME", "PRIVATE_CLERK", "PRIVATE_BUILD_SNAPSHOT", "PRIVATE_CHANNEL_TOKEN", "private@example.invalid"]) expect(text).not.toContain(secret);
    for (const item of result.profile.recentForm) expect(Object.keys(item).sort()).toEqual(["date", "matchup", "result"]);
  });

  test("switching a section off fences a warm aggregate cache on the next request", async () => {
    const h = harness({ config: { enabled: true, revision: 0, ...flags, showRecentForm: true } });
    expect((await h.players.get(SLUG)).profile.lastPlayedAt).toBeTruthy();
    Object.assign(h.state().publicProfile, { showRecentForm: false, revision: 1 });
    const after = await h.players.get(SLUG);
    for (const key of ["recentForm", "currentStreak", "lastPlayedAt"]) expect(after.profile).not.toHaveProperty(key);
  });
  test("the reviewer section drops arbitrary identity, token and unknown matchup leaves", async () => {
    const h = harness();
    h.opts.profile.reviewerReputation = { publicSection: jest.fn(async () => ({ karma: 5, reviews: 1, helpful: 0, bestAnswers: 0, badges: [], flair: null, token: "PRIVATE_REVIEW_TOKEN", userId: ID,
      verified: { band: { id: 5 }, race: "Protoss", mmr: 4100, pulseId: "PRIVATE_PULSE" },
      matchupsReviewed: [{ matchup: "PvT", count: 1, opponent: OPPONENT }, { matchup: OPPONENT, count: 100 }] })) };
    const result = await h.players.get(SLUG);
    expect(result.profile.reviewer.matchupsReviewed).toEqual([{ matchup: "PvT", count: 1 }]);
    expect(JSON.stringify(result)).not.toContain("PRIVATE_REVIEW_TOKEN"); expect(JSON.stringify(result)).not.toContain(ID); expect(JSON.stringify(result)).not.toContain(OPPONENT);
  });

  test("archive OFF removes the profile crosslink capability on the next read", async () => {
    const h = harness({ config: { enabled: true, revision: 0, ...flags, showReplays: true }, sharing: true });
    expect((await h.players.get(SLUG)).profile.replayArchive).toBeTruthy();
    h.state().replaySharing.enabled = false;
    expect((await h.players.get(SLUG)).profile.replayArchive).toBeNull();
  });
  test("unpublishing within a capped author list cannot reuse stale cached build metadata", async () => {
    const h = harness();
    const capped = { ...author, totalBuilds: 100, builds: Array.from({ length: 100 }, (_, index) => ({ slug: `build-${index}`, title: `Public build ${index}`, authorName: "Public name" })) };
    h.community.getAuthor.mockResolvedValue(capped);
    expect((await h.players.get(SLUG)).profile.publishedBuilds.some(build => build.slug === "build-1")).toBe(true);
    h.community.getAuthor.mockResolvedValue({ ...capped, builds: [...capped.builds.filter(build => build.slug !== "build-1"), { slug: "new-build", authorName: "Public name" }] });
    expect((await h.players.get(SLUG)).profile.publishedBuilds.some(build => build.slug === "build-1")).toBe(false);
  });

  test("unknown, arbitrary ids and private users allocate no address or aggregate work", async () => {
    const h = harness({ config: { enabled: false, revision: 0, ...flags }, named: false, slug: null });
    for (const value of ["arbitrary-user-id", "../../admin", ID]) expect(await h.players.get(value)).toBeNull();
    expect(h.db.users.updateOne).not.toHaveBeenCalled(); expect(h.opts.aggregations.summary).not.toHaveBeenCalled();
    h.erase(); expect(await h.players.get(ID)).toBeNull(); expect(h.db.users.updateOne).not.toHaveBeenCalled();
  });

  test("new address repair is legacy-only and changes no consent fields", async () => {
    const h = harness({ slug: null }); h.legacy();
    const before = structuredClone(h.state());
    const result = await h.players.get(ID);
    expect(validPlayerSlug(result.handle)).toBe(result.handle);
    expect(JSON.stringify(result)).not.toContain(ID);
    expect(h.mutations()).toBe(1);
    expect(h.state().publicProfile).toBeUndefined();
    expect(h.state().replaySharing.enabled).toBe(before.replaySharing.enabled);
    expect(Object.keys(h.db.users.updateOne.mock.calls[0][1].$set)).toEqual(["replaySharing.slug"]);
  });

  test("explicit OFF with named builds cannot trigger legacy address repair", async () => {
    const h = harness({ config: { enabled: false, revision: 0, ...flags }, slug: null });
    expect(await h.players.get(ID)).toBeNull(); expect(h.db.users.updateOne).not.toHaveBeenCalled();
  });

  test("legacy repair rechecks consent after its atomic address write", async () => {
    const h = harness({ slug: null }); h.legacy();
    h.community.getAuthor.mockResolvedValueOnce(author).mockResolvedValueOnce(author).mockResolvedValue(null);
    expect(await h.players.get(ID)).toBeNull();
    expect(h.opts.aggregations.summary).not.toHaveBeenCalled();
  });

  test("a failed legacy gate never allocates, including an author read error", async () => {
    const h = harness({ slug: null, named: false }); h.legacy();
    expect(await h.players.get(ID)).toBeNull();
    h.community.getAuthor.mockRejectedValueOnce(new Error("temporary database outage"));
    await expect(h.players.get(ID)).rejects.toThrow("temporary database outage");
    expect(h.db.users.updateOne).not.toHaveBeenCalled();
  });

  test("concurrent legacy readers converge on one canonical address", async () => {
    const h = harness({ slug: null }); h.legacy();
    const values = await Promise.all([h.players.get(ID), h.players.get(ID)]);
    expect(values[0].handle).toBe(values[1].handle); expect(h.mutations()).toBe(1);
  });
  test("legacy repair bounds unique-index collisions and exposes no consent mutation", async () => {
    const h = harness({ slug: null }); h.legacy();
    const realWrite = h.db.users.updateOne.getMockImplementation();
    h.db.users.updateOne.mockRejectedValueOnce({ code: 11000 }).mockRejectedValueOnce({ code: 11000 }).mockRejectedValueOnce({ code: 11000 }).mockImplementation(realWrite);
    expect((await h.players.get(ID)).handle).toEqual(expect.stringMatching(/-[a-f0-9]{10}$/));
    expect(h.db.users.updateOne).toHaveBeenCalledTimes(4); expect(h.state().publicProfile).toBeUndefined();
    const blocked = harness({ slug: null }); blocked.legacy();
    blocked.db.users.updateOne.mockRejectedValue({ code: 11000 });
    await expect(blocked.players.get(ID)).rejects.toMatchObject({ status: 503, code: "player_address_unavailable" });
    expect(blocked.db.users.updateOne).toHaveBeenCalledTimes(4); expect(blocked.mutations()).toBe(0);
  });

  test("syntax-valid old reserved-prefix links still resolve and can be reused", async () => {
    const reserved = "admin-0123456789", h = harness({ slug: reserved });
    expect((await h.players.get(reserved)).handle).toBe(reserved);
    expect(await h.preferences.availability(ID, reserved)).toEqual({ slug: reserved, available: true, reason: null });
  });
  test("named public build cards carry a canonical profile capability only while allowed", async () => {
    const h = harness();
    const named = { slug: "named", ownerUserId: ID, authorName: "Public name" };
    const anonymous = { slug: "anonymous", ownerUserId: ID, authorName: "", authorProfileHandle: SLUG };
    expect(await h.players.withAuthorLinks([named, anonymous])).toEqual([{ ...named, authorProfileHandle: SLUG }, { slug: "anonymous", ownerUserId: ID, authorName: "" }]);
    h.state().publicProfile.enabled = false;
    expect(await h.players.withAuthorLinks([named])).toEqual([named]);
  });
  test("profile publication never retroactively attributes anonymous build snapshots", () => {
    expect(publicBuilds([{ slug: "anonymous", authorName: null, ownerUserId: ID }, { slug: "blank", authorName: "  " }])).toEqual([]);
  });
});

describe("recent form allowlist", () => {
  test.each(["tie", "draw"])("%s breaks a win streak", tie => {
    const result = recentForm([row("win", "2026-10-25"), row(tie, "2026-10-24"), row("win", "2026-10-23")]);
    expect(result.currentStreak).toEqual({ kind: "W", count: 1 });
  });
  test("missing clocks/races and unknown results are omitted, and input is bounded", () => {
    expect(recentForm([row("bogus", "2026-10-25"), row("win", "2026-10-25", { my_race: null }), row("win", "2026-10-25", { date: "invalid" })]).recentForm).toEqual([]);
    expect(recentForm(Array.from({ length: 100 }, () => row("win", "2026-10-25"))).recentForm).toHaveLength(20);
  });
  test("omitting an unknown result never joins two wins into an invented streak", () => {
    expect(recentForm([row("win", "2026-10-25"), row("unknown", "2026-10-24"), row("win", "2026-10-23")]).currentStreak).toEqual({ kind: "W", count: 1 });
  });
  test("only absent configuration inherits legacy consent", () => {
    expect(publicPlayerSettings({}, true).legacyPublic).toBe(true);
    for (const value of [null, {}, { enabled: false }]) expect(publicPlayerSettings({ publicProfile: value }, true).legacyPublic).toBe(false);
  });
});

module.exports = { harness, ID, SLUG, flags };
