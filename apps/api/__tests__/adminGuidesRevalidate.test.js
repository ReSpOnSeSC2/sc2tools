// @ts-nocheck
"use strict";

/** Admin guide writes must purge cached public pages before reporting success. */
const express = require("express");
const request = require("supertest");
const pino = require("pino");
const { buildAdminGuidesRouter } = require("../src/routes/adminGuides");
const { buildErrorHandler } = require("../src/middleware/errorHandler");

const VIDEO_ID = "QCKXlUzx0rA";
const BUILD_KEY = "PvT - Charge First (Fast 3rd Nexus)";
const NOTE_PATH = "/v1/admin/guides/notes/pvt/charge-first-fast-3rd-nexus";
const VIDEOS_PATH = "/v1/admin/guides/videos";
const PIN = { videos: { pinned: [VIDEO_ID], hidden: [] } };
const NOTE = { matchup: "PvT", buildKey: BUILD_KEY, ...PIN };
const VIDEO = { youtubeId: VIDEO_ID, title: "Charge First PvT", hidden: false };
const SYNC = { fetched: 15, inserted: 1, updated: 0 };

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function harness() {
  const deps = {
    guideNotes: {
      list: jest.fn().mockResolvedValue([NOTE]),
      save: jest.fn().mockResolvedValue(NOTE),
      remove: jest.fn().mockResolvedValue(true),
    },
    guideVideos: {
      listForAdmin: jest.fn().mockResolvedValue([VIDEO]),
      addVideo: jest.fn().mockResolvedValue(VIDEO),
      setHidden: jest.fn().mockResolvedValue({ ...VIDEO, hidden: true }),
      syncFromChannel: jest.fn().mockResolvedValue(SYNC),
    },
    revalidate: jest.fn().mockResolvedValue({ ok: true, status: 200 }),
  };
  const app = express();
  const responses = [];
  app.use(express.json());
  app.use((req, res, next) => {
    req.auth = { userId: "u_admin" };
    responses.push(res);
    next();
  });
  app.use("/v1/admin/guides", buildAdminGuidesRouter(deps));
  app.use(buildErrorHandler(pino({ level: "silent" })));
  return { app, deps, responses };
}

describe("admin guide cache revalidation", () => {
  test("a pin is saved before purging and success waits for the purge", async () => {
    const { app, deps, responses } = harness();
    const started = deferred();
    const purge = deferred();
    const events = [];
    deps.guideNotes.save.mockImplementation(async () => {
      events.push("saved");
      return NOTE;
    });
    deps.revalidate.mockImplementation(() => {
      events.push("purging");
      started.resolve();
      return purge.promise;
    });
    const pending = request(app).put(NOTE_PATH).send(PIN).then((res) => res);
    try {
      await started.promise;
      expect(events).toEqual(["saved", "purging"]);
      expect(responses[0].writableEnded).toBe(false);
      expect(deps.guideNotes.save).toHaveBeenCalledWith("PvT", BUILD_KEY, PIN, "u_admin");
    } finally {
      purge.resolve({ ok: true, status: 200 });
    }
    const res = await pending;
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ note: NOTE });
    expect(res.headers["cache-control"]).toBe("private, no-store");
    expect(deps.revalidate).toHaveBeenCalledTimes(1);
  });

  test.each([
    ["delete note", "delete", NOTE_PATH, null, "guideNotes", "remove", 204],
    ["sync videos", "post", `${VIDEOS_PATH}/sync`, null, "guideVideos", "syncFromChannel", 200],
    ["add video", "post", VIDEOS_PATH, { youtubeId: VIDEO_ID }, "guideVideos", "addVideo", 201],
    ["hide video", "patch", `${VIDEOS_PATH}/${VIDEO_ID}`, { hidden: true }, "guideVideos", "setHidden", 200],
  ])("%s purges after the successful write", async (_label, method, path, body, service, operation, status) => {
    const { app, deps } = harness();
    const res = await request(app)[method](path).send(body);
    expect(res.status).toBe(status);
    expect(deps[service][operation]).toHaveBeenCalledTimes(1);
    expect(deps.revalidate).toHaveBeenCalledTimes(1);
    expect(deps[service][operation].mock.invocationCallOrder[0])
      .toBeLessThan(deps.revalidate.mock.invocationCallOrder[0]);
  });
});

describe("admin guide rejected mutations", () => {
  test.each([
    ["pin", "put", NOTE_PATH, PIN, "guideNotes", "save"],
    ["delete", "delete", NOTE_PATH, null, "guideNotes", "remove"],
    ["sync", "post", `${VIDEOS_PATH}/sync`, null, "guideVideos", "syncFromChannel"],
    ["add", "post", VIDEOS_PATH, { youtubeId: VIDEO_ID }, "guideVideos", "addVideo"],
    ["hide", "patch", `${VIDEOS_PATH}/${VIDEO_ID}`, { hidden: true }, "guideVideos", "setHidden"],
  ])("a failed %s write does not purge", async (_label, method, path, body, service, operation) => {
    const { app, deps } = harness();
    deps[service][operation].mockRejectedValue(new Error("write_failed"));
    const res = await request(app)[method](path).send(body);
    expect(res.status).toBe(500);
    expect(deps.revalidate).not.toHaveBeenCalled();
  });

  test("an invalid note rejected by its service does not purge", async () => {
    const { app, deps } = harness();
    deps.guideNotes.save.mockRejectedValue(Object.assign(new Error("invalid note"), {
      status: 400, code: "invalid_note",
    }));
    const res = await request(app).put(NOTE_PATH).send({ videos: { pinned: ["bad-id"] } });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("invalid_note");
    expect(deps.revalidate).not.toHaveBeenCalled();
  });

  test.each([
    ["put", "/v1/admin/guides/notes/pvt/unknown-build", PIN, 404],
    ["delete", "/v1/admin/guides/notes/pvt/unknown-build", null, 404],
    ["post", VIDEOS_PATH, { youtubeId: "bad-id" }, 400],
    ["patch", `${VIDEOS_PATH}/${VIDEO_ID}`, { hidden: "yes" }, 400],
  ])("%s %s rejects invalid mutations without writing or purging", async (method, path, body, status) => {
    const { app, deps } = harness();
    const res = await request(app)[method](path).send(body);
    expect(res.status).toBe(status);
    expect(deps.guideNotes.save).not.toHaveBeenCalled();
    expect(deps.guideNotes.remove).not.toHaveBeenCalled();
    expect(deps.guideVideos.addVideo).not.toHaveBeenCalled();
    expect(deps.guideVideos.setHidden).not.toHaveBeenCalled();
    expect(deps.revalidate).not.toHaveBeenCalled();
  });
});

describe("admin guide purge availability", () => {
  test("hiding an unknown video does not purge", async () => {
    const { app, deps } = harness();
    deps.guideVideos.setHidden.mockResolvedValue(null);
    const res = await request(app).patch(`${VIDEOS_PATH}/${VIDEO_ID}`).send({ hidden: true });
    expect(res.status).toBe(404);
    expect(deps.revalidate).not.toHaveBeenCalled();
  });

  test("a video rejected by channel verification does not purge", async () => {
    const { app, deps } = harness();
    deps.guideVideos.addVideo.mockRejectedValue(Object.assign(new Error("wrong channel"), {
      status: 422, code: "video_not_on_channel",
    }));
    const res = await request(app).post(VIDEOS_PATH).send({ youtubeId: VIDEO_ID });
    expect(res.status).toBe(422);
    expect(deps.revalidate).not.toHaveBeenCalled();
  });

  test.each([
    { ok: false, error: "timeout" },
    { ok: false, status: 503 },
    { ok: false, skipped: "not_configured" },
  ])("a fail-soft purge result %j preserves the successful pin", async (result) => {
    const { app, deps } = harness();
    deps.revalidate.mockResolvedValue(result);
    const res = await request(app).put(NOTE_PATH).send(PIN);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ note: NOTE });
    expect(deps.revalidate).toHaveBeenCalledTimes(1);
  });

  test("read-only admin requests do not purge", async () => {
    const { app, deps } = harness();
    expect((await request(app).get("/v1/admin/guides/notes")).status).toBe(200);
    expect((await request(app).get(VIDEOS_PATH)).status).toBe(200);
    expect(deps.revalidate).not.toHaveBeenCalled();
  });

  test("the revalidator remains optional for unconfigured deployments", async () => {
    const { app, deps } = harness();
    delete deps.revalidate;
    const res = await request(app).put(NOTE_PATH).send(PIN);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ note: NOTE });
  });
});
