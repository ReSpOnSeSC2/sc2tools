// @ts-nocheck
"use strict";

const request = require("supertest");
const { GUIDE_CACHE_CONTROL } = require("../src/config/guides");
const { PATCH_5_0_16_RELEASE, PATCH_5_0_17_RELEASE } = require("../src/util/patchEra");
const { TWELVE_WORKERS, EIGHT_WORKERS } = require("../src/services/guideVideos");
const { createGuidesHarness, CHANNEL_ID, CHANNEL_URL } = require("./helpers/guidesHarness");

jest.mock("@clerk/backend", () => require("./helpers/clerkMock")());

const ids = (videos) => videos.map((video) => video.youtubeId);
const videoId = (workers, index) => `v${String(workers).padStart(2, "0")}${String(index).padStart(8, "0")}`;

function video(workers, index, extra = {}) {
  const release = workers === EIGHT_WORKERS ? PATCH_5_0_16_RELEASE : PATCH_5_0_17_RELEASE;
  return {
    youtubeId: videoId(workers, index),
    title: "PvZ Stargate into Glaives",
    description: "Build order guide",
    publishedAt: new Date(release.getTime() + index * 1000),
    channelId: CHANNEL_ID,
    source: "admin",
    hidden: false,
    isShort: false,
    ...extra,
  };
}

describe("public guide video collection", () => {
  let h;
  const newestIds = (workers) => Array.from({ length: 15 }, (_, i) => videoId(workers, 14 - i));

  beforeAll(async () => {
    h = await createGuidesHarness();
    await h.db.guideVideos.insertMany([
      ...Array.from({ length: 15 }, (_, i) => video(TWELVE_WORKERS, i)),
      ...Array.from({ length: 15 }, (_, i) => video(EIGHT_WORKERS, i)),
      video(TWELVE_WORKERS, 20, { hidden: true }),
      video(TWELVE_WORKERS, 21, { isShort: true }),
      video(TWELVE_WORKERS, 22, { title: "PvZ live stream" }),
    ]);
  });

  afterAll(async () => {
    if (h) await h.close();
  });

  test("the hub grows to eight videos while matchup previews stay at four", async () => {
    const hub = await request(h.app).get("/v1/guides");
    expect(hub.status).toBe(200);
    expect(ids(hub.body.videos)).toEqual(newestIds(TWELVE_WORKERS).slice(0, 8));
    const matchup = await request(h.app).get("/v1/guides/pvz");
    expect(matchup.status).toBe(200);
    expect(ids(matchup.body.videos)).toEqual(newestIds(TWELVE_WORKERS).slice(0, 4));
  });

  test("the public collection returns more than twelve videos in each era, newest first", async () => {
    const res = await request(h.app).get("/v1/guides/videos");
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe(GUIDE_CACHE_CONTROL);
    expect(Object.keys(res.body).sort()).toEqual(["channel", "eightWorkerVideos", "playlists", "videos"]);
    expect(ids(res.body.videos)).toEqual(newestIds(TWELVE_WORKERS));
    expect(ids(res.body.eightWorkerVideos)).toEqual(newestIds(EIGHT_WORKERS));
    expect(res.body.videos.every((v) => v.eightWorkerPatch === false)).toBe(true);
    expect(res.body.eightWorkerVideos.every((v) => v.eightWorkerPatch === true)).toBe(true);
    expect(res.body.channel).toEqual({ url: CHANNEL_URL, name: "ReSpOnSeSC2" });
    expect(res.body.playlists).toEqual({ twelveWorker: null, eightWorker: null });
    for (const item of [...res.body.videos, ...res.body.eightWorkerVideos]) {
      for (const storage of ["hidden", "source", "channelId", "_id", "_schemaVersion"]) {
        expect(item).not.toHaveProperty(storage);
      }
    }
  });

  test("collection results cannot mutate the shared video cache", async () => {
    const all = await h.guideVideos.all(TWELVE_WORKERS);
    all[0].title = "changed by caller";
    const reread = await h.guideVideos.all(TWELVE_WORKERS);
    expect(reread[0].title).toBe("PvZ Stargate into Glaives");
  });
});
