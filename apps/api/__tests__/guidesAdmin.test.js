// @ts-nocheck
"use strict";

/**
 * /v1/admin/guides/* through the full app: admin-only (403 for everyone
 * else), private no-store, coach's notes CRUD (and the public page
 * showing the note without its editor), status, "Recompute now" in the
 * background, the samples backfill (409 when disabled), and the video
 * panel (oEmbed-checked add with an injectable fetch and a 5 s timeout
 * signal, hide, sync).
 */

const fs = require("fs");
const path = require("path");
const request = require("supertest");
const { createGuidesHarness, seedGuideCorpus, GLAIVES } = require("./helpers/guidesHarness");

jest.mock("@clerk/backend", () => require("./helpers/clerkMock")());

const FEED = fs.readFileSync(path.join(__dirname, "fixtures", "guides", "youtube-channel-feed.xml"), "utf8");
const NOTE_PATH = "/v1/admin/guides/notes/pvz/stargate-into-glaives";
const CHANNEL_URL = "https://www.youtube.com/@ReSpOnSeSC2";
const POLL_MS = 25;
const POLL_TRIES = 400;

/** @param {string} body @param {number} [status] */
function textResponse(body, status = 200) {
  return new Response(body, { status });
}

async function waitFor(check) {
  for (let i = 0; i < POLL_TRIES; i += 1) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  throw new Error("waitFor timed out");
}

describe("/v1/admin/guides", () => {
  let h; let adminId;
  const fetchMock = jest.fn();
  const as = (name, req) => req.set("authorization", `Bearer u:${name}`);
  const admin = (req) => as("admin", req);

  beforeAll(async () => {
    h = await createGuidesHarness({ fetchImpl: (...args) => fetchMock(...args) });
    adminId = await h.seedUser("admin");
    await h.seedUser("player");
    await seedGuideCorpus(h);
  });

  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockImplementation(async () => {
      throw new Error("network_disabled_in_tests");
    });
  });

  afterAll(async () => {
    if (h) await h.close();
  });

  test.each([
    ["get", "/v1/admin/guides/notes"],
    ["put", NOTE_PATH],
    ["delete", NOTE_PATH],
    ["get", "/v1/admin/guides/status"],
    ["post", "/v1/admin/guides/recompute"],
    ["get", "/v1/admin/guides/backfill"],
    ["post", "/v1/admin/guides/backfill"],
    ["get", "/v1/admin/guides/videos"],
    ["post", "/v1/admin/guides/videos"],
    ["patch", "/v1/admin/guides/videos/YcTMc_Ee11w"],
    ["post", "/v1/admin/guides/videos/sync"],
  ])("%s %s is admin-only", async (method, url) => {
    const anon = await request(h.app)[method](url).send({});
    expect(anon.status).toBe(401);
    const player = await as("player", request(h.app)[method](url)).send({});
    expect(player.status).toBe(403);
    expect(player.body).toEqual({ error: { code: "admin_only" } });
  });

  test("notes: save, list, public page without the editor, delete", async () => {
    const saved = await admin(request(h.app).put(NOTE_PATH)).send({ body: "### Plan\nHide the Twilight." });
    expect(saved.status).toBe(200);
    expect(saved.headers["cache-control"]).toBe("private, no-store");
    expect(saved.body.note).toMatchObject({
      matchup: "PvZ", buildKey: GLAIVES, buildSlug: "stargate-into-glaives", body: "### Plan\nHide the Twilight.",
      videos: { pinned: [], hidden: [] },
    });
    expect(saved.body.note).not.toHaveProperty("updatedBy");
    expect((await h.db.guideNotes.findOne({ buildKey: GLAIVES })).updatedBy).toBe(adminId);

    const list = await admin(request(h.app).get("/v1/admin/guides/notes"));
    expect(list.body.items).toHaveLength(1);
    expect(JSON.stringify(list.body)).not.toContain(adminId);

    const page = await request(h.app).get("/v1/guides/pvz/stargate-into-glaives");
    expect(page.body.notes).toEqual({ body: "### Plan\nHide the Twilight.", updatedAt: saved.body.note.updatedAt });
    expect(JSON.stringify(page.body)).not.toContain(adminId);

    const del = await admin(request(h.app).delete(NOTE_PATH));
    expect(del.status).toBe(204);
    expect((await admin(request(h.app).delete(NOTE_PATH))).status).toBe(204);
    expect((await request(h.app).get("/v1/guides/pvz/stargate-into-glaives")).body.notes).toBeNull();
  });

  test("notes: pins reorder the build's videos, per-guide hides remove them", async () => {
    // Every channel video so far is from the 8-worker patch, so the
    // 12-worker page shows one only when it is pinned.
    const before = await request(h.app).get("/v1/guides/pvz/stargate-into-glaives");
    expect(before.body.videos).toEqual([]);
    const pin = await admin(request(h.app).put(NOTE_PATH)).send({ videos: { pinned: ["A4x6gR7J-AY"], hidden: ["YcTMc_Ee11w"] } });
    expect(pin.status).toBe(200);
    const page = await request(h.app).get("/v1/guides/pvz/stargate-into-glaives");
    expect(page.body.videos.map((v) => v.youtubeId)).toEqual(["A4x6gR7J-AY"]);
    await admin(request(h.app).delete(NOTE_PATH));
  });

  test.each([
    ["an unknown build", "/v1/admin/guides/notes/pvz/not-a-build", { body: "x" }, 404, "not_found"],
    ["an unknown matchup", "/v1/admin/guides/notes/pvx/stargate-into-glaives", { body: "x" }, 404, "not_found"],
    ["an over-long body", NOTE_PATH, { body: "x".repeat(4001) }, 400, "invalid_note"],
    ["an unknown field", NOTE_PATH, { body: "x", updatedBy: "me" }, 400, "invalid_note"],
  ])("notes: %s → %i", async (_label, url, body, status, code) => {
    const res = await admin(request(h.app).put(url)).send(body);
    expect(res.status).toBe(status);
    expect(res.body.error.code).toBe(code);
  });

  test("status, then Recompute now runs in the background", async () => {
    const before = await admin(request(h.app).get("/v1/admin/guides/status"));
    expect(before.status).toBe(200);
    expect(before.headers["cache-control"]).toBe("private, no-store");
    expect(before.body).toMatchObject({
      run: { computedAt: expect.any(String), durationMs: expect.any(Number), counts: { published: 1, counters: 1, maps: 1 } },
      backfill: { disabled: false, running: false, processed: 0 },
      samples: { count: 36 },
      recompute: { running: false, requestedAt: null, last: null },
    });
    const started = await admin(request(h.app).post("/v1/admin/guides/recompute"));
    expect(started.status).toBe(202);
    expect(started.body).toEqual({ started: true });
    const done = await waitFor(async () => {
      const res = await admin(request(h.app).get("/v1/admin/guides/status"));
      return res.body.recompute.last ? res.body : null;
    });
    expect(done.recompute.last).toMatchObject({ ran: true, reason: null });
    expect(Date.parse(done.run.computedAt)).toBeGreaterThan(Date.parse(before.body.run.computedAt));
  });

  test("backfill: validated start / stop with a 202 status", async () => {
    for (const body of [{}, { action: "go" }, { action: "start", days: 0 }, { action: "start", days: 401 }, { action: "start", days: 2.5 }]) {
      const bad = await admin(request(h.app).post("/v1/admin/guides/backfill")).send(body);
      expect(bad.status).toBe(400);
      expect(bad.body.error.code).toBe("invalid_backfill");
    }
    const start = await admin(request(h.app).post("/v1/admin/guides/backfill")).send({ action: "start", days: 30 });
    expect(start.status).toBe(202);
    expect(start.body).toMatchObject({ disabled: false, days: 30 });
    const stop = await admin(request(h.app).post("/v1/admin/guides/backfill")).send({ action: "stop" });
    expect(stop.status).toBe(202);
    expect(stop.body).toMatchObject({ running: false, days: 30 });
    const status = await admin(request(h.app).get("/v1/admin/guides/backfill"));
    expect(status.status).toBe(200);
    expect(status.body).toMatchObject({ disabled: false, running: false, days: 30, lastError: null });
  });

  test("videos: the admin list carries detected matches and moderation flags", async () => {
    const res = await admin(request(h.app).get("/v1/admin/guides/videos"));
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("private, no-store");
    expect(res.body.items).toHaveLength(32);
    expect(res.body.items.find((v) => v.youtubeId === "YcTMc_Ee11w")).toMatchObject({
      matchup: "PvZ", builds: [GLAIVES], source: "snapshot", hidden: false,
    });
  });

  test("videos: add by id (oEmbed title, 5 s timeout signal) → 201", async () => {
    fetchMock.mockImplementation(async (url, init) => {
      expect(String(url)).toContain("https://www.youtube.com/oembed?url=");
      expect(init.signal).toBeInstanceOf(AbortSignal);
      return textResponse(JSON.stringify({ title: "PvT New Build", author_url: CHANNEL_URL }));
    });
    const res = await admin(request(h.app).post("/v1/admin/guides/videos")).send({ youtubeId: "Zz9_yy8-XX7" });
    expect(res.status).toBe(201);
    expect(res.body.item).toMatchObject({ youtubeId: "Zz9_yy8-XX7", title: "PvT New Build", publishedAt: null, source: "admin" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test.each([
    ["the lookup 404s", async () => textResponse("Not Found", 404), 422, "video_lookup_http_404"],
    ["the lookup times out", async () => {
      throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
    }, 422, "video_lookup_timeout"],
    ["the video is another channel's", async () => textResponse(JSON.stringify({
      title: "x", author_url: "https://www.youtube.com/@SomeoneElse",
    })), 422, "video_not_on_channel"],
  ])("videos: add fails when %s → %i", async (_label, impl, status, code) => {
    fetchMock.mockImplementation(impl);
    const res = await admin(request(h.app).post("/v1/admin/guides/videos")).send({ youtubeId: "Qq1_ww2-EE3" });
    expect(res.status).toBe(status);
    expect(res.body).toEqual({ error: { code } });
    expect(await h.db.guideVideos.countDocuments({ youtubeId: "Qq1_ww2-EE3" })).toBe(0);
  });

  test("videos: a malformed id is a 400 without any lookup", async () => {
    const res = await admin(request(h.app).post("/v1/admin/guides/videos")).send({ youtubeId: "nope" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("invalid_video_id");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("videos: hide globally, then show again", async () => {
    await admin(request(h.app).put(NOTE_PATH)).send({ videos: { pinned: ["YcTMc_Ee11w"], hidden: [] } });
    const pinned = await request(h.app).get("/v1/guides/pvz/stargate-into-glaives");
    expect(pinned.body.videos.map((v) => v.youtubeId)).toEqual(["YcTMc_Ee11w"]);
    const hide = await admin(request(h.app).patch("/v1/admin/guides/videos/YcTMc_Ee11w")).send({ hidden: true });
    expect(hide.status).toBe(200);
    expect(hide.body.item).toMatchObject({ youtubeId: "YcTMc_Ee11w", hidden: true, eightWorkerPatch: true });
    const page = await request(h.app).get("/v1/guides/pvz/stargate-into-glaives");
    expect(page.body.videos.map((v) => v.youtubeId)).not.toContain("YcTMc_Ee11w");
    await admin(request(h.app).delete(NOTE_PATH));
    const show = await admin(request(h.app).patch("/v1/admin/guides/videos/YcTMc_Ee11w")).send({ hidden: false });
    expect(show.body.item.hidden).toBe(false);
    expect((await admin(request(h.app).patch("/v1/admin/guides/videos/Ab1_cd2-EF3")).send({ hidden: true })).status).toBe(404);
    expect((await admin(request(h.app).patch("/v1/admin/guides/videos/YcTMc_Ee11w")).send({ hidden: "yes" })).status).toBe(400);
    expect((await admin(request(h.app).patch("/v1/admin/guides/videos/bad")).send({ hidden: true })).status).toBe(400);
  });

  test("videos: sync now pulls the channel feed; a feed failure is a coded 502", async () => {
    fetchMock.mockImplementation(async () => textResponse(FEED));
    const ok = await admin(request(h.app).post("/v1/admin/guides/videos/sync"));
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ fetched: expect.any(Number), inserted: expect.any(Number), updated: expect.any(Number) });
    expect(ok.body.fetched).toBeGreaterThan(0);
    fetchMock.mockImplementation(async () => textResponse("oops", 500));
    const bad = await admin(request(h.app).post("/v1/admin/guides/videos/sync"));
    expect(bad.status).toBe(502);
    expect(bad.body).toEqual({ error: { code: "feed_http_500" } });
  });
});

describe("/v1/admin/guides with the kill switches on", () => {
  let h;
  const admin = (req) => req.set("authorization", "Bearer u:admin");

  beforeAll(async () => {
    process.env.SC2TOOLS_GUIDE_STATS_DISABLED = "1";
    process.env.SC2TOOLS_GUIDE_BACKFILL_DISABLED = "1";
    try {
      h = await createGuidesHarness();
    } finally {
      delete process.env.SC2TOOLS_GUIDE_STATS_DISABLED;
      delete process.env.SC2TOOLS_GUIDE_BACKFILL_DISABLED;
    }
    await h.seedUser("admin");
  });

  afterAll(async () => {
    if (h) await h.close();
  });

  test("Recompute now surfaces the disabled job as a 409", async () => {
    const res = await admin(request(h.app).post("/v1/admin/guides/recompute"));
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: { code: "guide_stats_disabled" } });
    const status = await admin(request(h.app).get("/v1/admin/guides/status"));
    expect(status.body.recompute).toEqual({ running: false, requestedAt: null, last: null });
    expect(status.body.run).toBeNull();
  });

  test("backfill start is a 409 while disabled; stop still answers", async () => {
    const start = await admin(request(h.app).post("/v1/admin/guides/backfill")).send({ action: "start" });
    expect(start.status).toBe(409);
    expect(start.body).toEqual({ error: { code: "backfill_disabled" } });
    const stop = await admin(request(h.app).post("/v1/admin/guides/backfill")).send({ action: "stop" });
    expect(stop.status).toBe(202);
    expect(stop.body).toMatchObject({ disabled: true, running: false });
  });
});
