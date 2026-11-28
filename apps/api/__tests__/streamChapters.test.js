// @ts-nocheck
"use strict";

const { StreamChaptersService, chapterLines, withChapterBlock, formatOffset, roundedRating, BLOCK_START, BLOCK_END, MESSAGES } = require("../src/services/streamChapters");

const ORIGIN = Date.parse("2026-11-27T18:00:00Z");
/** A game that started `startSec` after the origin and lasted `lengthSec`. */
function game(startSec, lengthSec, extra = {}) {
  return { date: new Date(ORIGIN + (startSec + lengthSec) * 1000), durationSec: lengthSec, result: "Victory",
    myRace: "Protoss", opponent: { race: "Zerg", mmr: 5050 }, ...extra };
}
const three = [game(60, 600), game(900, 700, { result: "Defeat", opponent: { race: "Terran", mmr: 4930 } }), game(2530, 400, { result: "Tie" })];

test("a video that ended early gets no chapter for a game that started after it ended", () => {
  const rows = [game(60, 300), game(700, 300), game(2000, 300), game(2400, 300)];
  const { lines } = chapterLines(rows, ORIGIN, { endMs: ORIGIN + 1800_000 });
  expect(lines).toEqual(["0:00 Stream start", "1:00 Game 1 · PvZ win vs 5.1k", "11:40 Game 2 · PvZ win vs 5.1k"]);
  expect(chapterLines(rows, ORIGIN).lines).toHaveLength(5);
});

test("a game start comes from startedAt when there is one, so a row with no duration still gets its chapter and number", () => {
  const exact = { date: new Date(ORIGIN + 2000_000), startedAt: new Date(ORIGIN + 900_000), result: "Victory", myRace: "Protoss", opponent: { race: "Zerg" } };
  const { lines } = chapterLines([game(60, 600), exact, game(1500, 400)], ORIGIN);
  expect(lines).toEqual(["0:00 Stream start", "1:00 Game 1 · PvZ win vs 5.1k", "15:00 Game 2 · PvZ win", "25:00 Game 3 · PvZ win vs 5.1k"]);
});

test("each chapter names the game, matchup, result and a rating rounded to 100, never a person", () => {
  const { lines } = chapterLines(three, ORIGIN);
  expect(lines).toEqual(["0:00 Stream start", "1:00 Game 1 · PvZ win vs 5.1k", "15:00 Game 2 · PvT loss vs 4.9k", "42:10 Game 3 · PvZ vs 5.1k"]);
});

test("a first game inside ten seconds of the start takes the 0:00 slot", () => {
  const { lines } = chapterLines([game(4, 300), game(400, 300), game(800, 300)], ORIGIN);
  expect(lines[0]).toBe("0:00 Game 1 · PvZ win vs 5.1k");
  expect(lines).toHaveLength(3);
});

test("games that started before the video, or without a length, are left out and numbering stays true", () => {
  const rows = [game(-500, 300), { ...game(100, 100), durationSec: undefined }, game(200, 300), game(700, 300), game(1200, 300)];
  const { lines } = chapterLines(rows, ORIGIN);
  expect(lines).toEqual(["0:00 Stream start", "3:20 Game 2 · PvZ win vs 5.1k", "11:40 Game 3 · PvZ win vs 5.1k", "20:00 Game 4 · PvZ win vs 5.1k"]);
});

test("fewer than three chapters or two inside ten seconds writes nothing", () => {
  expect(chapterLines([game(4, 100), game(300, 100)], ORIGIN)).toEqual({ reason: "too_few" });
  expect(chapterLines([], ORIGIN)).toEqual({ reason: "too_few" });
  expect(chapterLines([game(60, 100), game(65, 50), game(400, 100)], ORIGIN)).toEqual({ reason: "too_close" });
});

test("offsets past an hour use H:MM:SS and a missing rating is simply omitted", () => {
  expect(formatOffset(3_725_000)).toBe("1:02:05");
  expect(formatOffset(-5)).toBe("0:00");
  expect(roundedRating(949)).toBe("900");
  expect(roundedRating(null)).toBeNull();
  const { lines } = chapterLines([game(60, 100, { opponent: { race: "Zerg" } }), game(300, 100), game(600, 100)], ORIGIN);
  expect(lines[1]).toBe("1:00 Game 1 · PvZ win");
});

describe("the marked block", () => {
  const lines = ["0:00 Stream start", "1:00 Game 1 · PvZ win"];
  const block = `${BLOCK_START}\n${lines.join("\n")}\n${BLOCK_END}`;

  test("goes after the streamer's own text and leaves it alone", () => {
    expect(withChapterBlock("My stream\nLinks: example.com\n", lines)).toBe(`My stream\nLinks: example.com\n\n${block}`);
    expect(withChapterBlock("", lines)).toBe(block);
  });

  test("a second run replaces the block and nothing around it", () => {
    const first = withChapterBlock("Intro\n\nOutro", lines);
    const second = withChapterBlock(first, ["0:00 Stream start", "2:00 Game 1 · PvT loss"]);
    expect(second).toBe(`Intro\n\nOutro\n\n${BLOCK_START}\n0:00 Stream start\n2:00 Game 1 · PvT loss\n${BLOCK_END}`);
    expect(withChapterBlock(second, ["0:00 Stream start", "2:00 Game 1 · PvT loss"])).toBe(second);
  });

  test("text between and after the markers that is not ours survives a replacement", () => {
    const description = `Top\n${block}\nBottom $& line`;
    expect(withChapterBlock(description, ["0:00 A"])).toBe(`Top\n${BLOCK_START}\n0:00 A\n${BLOCK_END}\nBottom $& line`);
  });
});

function fakeGames(rows) {
  const calls = [];
  return { calls, find: (filter) => { calls.push(filter); return { sort: () => ({ limit: () => ({ toArray: async () => rows }) }) }; } };
}

describe("the service", () => {
  test("copyable text counts from the marked stream start and says why when there is none", async () => {
    const service = new StreamChaptersService({ enabled: true, games: fakeGames(three) });
    expect(await service.copyable("u", ORIGIN, ORIGIN + 4000_000)).toMatchObject({ message: "", lines: expect.arrayContaining(["1:00 Game 1 · PvZ win vs 5.1k"]) });
    expect(await service.copyable("u", null, ORIGIN)).toEqual({ lines: [], message: MESSAGES.no_start });
    const sparse = new StreamChaptersService({ enabled: true, games: fakeGames([game(60, 100)]) });
    // Twitch and Kick have no three-chapter or ten-second rule, so one game is still copyable.
    expect(await sparse.copyable("u", ORIGIN, ORIGIN + 1e6)).toEqual({ lines: ["0:00 Stream start", "1:00 Game 1 · PvZ win vs 5.1k"], message: "" });
    const empty = new StreamChaptersService({ enabled: true, games: fakeGames([]) });
    expect(await empty.copyable("u", ORIGIN, ORIGIN + 1e6)).toEqual({ lines: [], message: MESSAGES.no_games });
  });

  test("the server gate keeps every YouTube write off, and each archive leaves a receipt", async () => {
    const source = youtube([{ id: "a", state: "written" }, { id: "b", state: "skipped", reason: "too_few" }]);
    const off = new StreamChaptersService({ games: fakeGames(three), youtube: source });
    expect(await off.writeToYoutube("u", ORIGIN, ORIGIN + 5e6)).toEqual({ state: "skipped", message: MESSAGES.not_enabled });
    expect(source.calls).toHaveLength(0);
    const recorded = [];
    const receipts = { record: async (userId, rows) => { recorded.push([userId, rows]); } };
    await new StreamChaptersService({ enabled: true, games: fakeGames(three), youtube: source, receipts }).writeToYoutube("u", ORIGIN, ORIGIN + 5e6);
    expect(recorded).toEqual([["u", [{ id: "a", state: "written" }, { id: "b", state: "skipped", reason: "too_few" }]]]);
    const broken = { record: async () => { throw new Error("db down"); } };
    expect((await new StreamChaptersService({ enabled: true, games: fakeGames(three), youtube: source, receipts: broken }).writeToYoutube("u", ORIGIN, ORIGIN + 5e6)).state).toBe("written");
  });

  test("games are read for this owner and the stream window only", async () => {
    const source = fakeGames(three);
    await new StreamChaptersService({ enabled: true, games: source }).copyable("owner-1", ORIGIN, ORIGIN + 5000);
    expect(source.calls[0]).toMatchObject({ userId: "owner-1", date: { $gte: new Date(ORIGIN), $lte: new Date(ORIGIN + 5000) } });
  });

  function youtube(receipts) {
    const calls = [];
    return { calls, archiveDescriptions: async (userId, job) => { calls.push({ userId, job }); return typeof receipts === "function" ? receipts(job) : receipts; } };
  }

  test("YouTube is asked once and each video is composed against its own start", async () => {
    const source = youtube((job) => [{ id: "a", state: job.compose(ORIGIN, "Hello").description ? "written" : "failed" },
      { id: "b", state: job.compose(ORIGIN + 30_000, "").description ? "written" : "failed" }]);
    const result = await new StreamChaptersService({ enabled: true, games: fakeGames(three), youtube: source }).writeToYoutube("u", ORIGIN, ORIGIN + 5e6);
    expect(result).toEqual({ state: "written", message: "Added the game chapters to 2 YouTube archives." });
    expect(source.calls).toHaveLength(1);
    expect(source.calls[0].job).toMatchObject({ fromMs: ORIGIN, toMs: ORIGIN + 5e6 });
    const composed = source.calls[0].job.compose(ORIGIN, "Hello");
    expect(composed.description.startsWith("Hello\n\n" + BLOCK_START)).toBe(true);
  });

  test("a list that breaks a YouTube rule is never written, and the Dock is told why", async () => {
    const source = youtube((job) => [{ id: "a", state: "skipped", reason: job.compose(ORIGIN, "x").skip }]);
    const result = await new StreamChaptersService({ enabled: true, games: fakeGames([game(60, 100)]), youtube: source }).writeToYoutube("u", ORIGIN, ORIGIN + 1e6);
    expect(result).toEqual({ state: "skipped", message: MESSAGES.too_few });
  });

  test("a description with no room left is skipped", async () => {
    let skipped;
    const source = youtube((job) => { skipped = job.compose(ORIGIN, "x".repeat(4990)); return [{ id: "a", state: "skipped" }]; });
    const result = await new StreamChaptersService({ enabled: true, games: fakeGames(three), youtube: source }).writeToYoutube("u", ORIGIN, ORIGIN + 5e6);
    expect(skipped).toEqual({ skip: "too_long" });
    expect(result).toEqual({ state: "skipped", message: MESSAGES.too_long });
  });

  test("no broadcast, no stream start, a provider failure and a thrown error each end in an answer, never an exception", async () => {
    const make = (receipts) => new StreamChaptersService({ enabled: true, games: fakeGames(three), youtube: youtube(receipts) });
    expect(await make([]).writeToYoutube("u", ORIGIN, ORIGIN + 5e6)).toEqual({ state: "skipped", message: MESSAGES.no_broadcast });
    expect(await make([]).writeToYoutube("u", null, ORIGIN)).toEqual({ state: "skipped", message: MESSAGES.no_start });
    expect(await make([{ id: "a", state: "failed", reason: "youtube_ownership_changed" }]).writeToYoutube("u", ORIGIN, ORIGIN + 5e6))
      .toEqual({ state: "failed", message: MESSAGES.failed });
    const broken = new StreamChaptersService({ enabled: true, games: fakeGames(three), youtube: { archiveDescriptions: async () => { throw new Error("grant missing"); } } });
    expect(await broken.writeToYoutube("u", ORIGIN, ORIGIN + 5e6)).toEqual({ state: "failed", message: MESSAGES.failed });
    expect(await new StreamChaptersService({ enabled: true, games: fakeGames(three) }).writeToYoutube("u", ORIGIN, ORIGIN)).toEqual({ state: "skipped", message: MESSAGES.no_broadcast });
  });

  test("one video written and another failed is reported as written with a note", async () => {
    const result = await new StreamChaptersService({ enabled: true, games: fakeGames(three), youtube: youtube([{ id: "a", state: "written" }, { id: "b", state: "failed" }]) })
      .writeToYoutube("u", ORIGIN, ORIGIN + 5e6);
    expect(result).toEqual({ state: "written", message: "Added the game chapters to the YouTube archive. Another video could not be updated." });
  });
});

describe("the server gate and the receipts store", () => {
  const { loadConfig } = require("../src/config/loader");
  const { YoutubeChapterReceipts } = require("../src/services/youtubeChapterReceipts");

  test("the gate is false unless the owner sets the exact value true", () => {
    const env = { MONGODB_URI: "mongodb://fixture.invalid/test", CLERK_SECRET_KEY: "mock-only", SERVER_PEPPER_HEX: "a".repeat(64) };
    for (const value of [undefined, "", "false", "1", "on"]) expect(loadConfig({ ...env, YOUTUBE_CHAPTERS_ENABLED: value }).youtubeChaptersEnabled).toBe(false);
    expect(loadConfig({ ...env, YOUTUBE_CHAPTERS_ENABLED: "true" }).youtubeChaptersEnabled).toBe(true);
  });

  test("a receipt holds the video, the state and the reason only, one row per video, and expires", async () => {
    const writes = [], indexes = [];
    const collection = { createIndex: async (...args) => { indexes.push(args); }, updateOne: async (...args) => { writes.push(args); } };
    const store = new YoutubeChapterReceipts({ collection, now: () => ORIGIN });
    await store.ensureIndexes();
    await store.record("u", [{ id: "a", state: "written" }, { id: "b", state: "skipped", reason: "too_few" }]);
    expect(indexes[0][1]).toEqual({ unique: true });
    expect(indexes[1][1]).toEqual({ expireAfterSeconds: 0 });
    expect(writes.map(([filter]) => filter)).toEqual([{ userId: "u", broadcastId: "a" }, { userId: "u", broadcastId: "b" }]);
    expect(writes[1][1].$set).toEqual({ state: "skipped", reason: "too_few", at: new Date(ORIGIN), expiresAt: new Date(ORIGIN + 90 * 86400_000) });
    expect(writes[1][2]).toEqual({ upsert: true });
  });
});
