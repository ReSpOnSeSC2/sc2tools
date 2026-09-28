// @ts-nocheck
"use strict";

const request = require("supertest");

jest.mock("@clerk/backend", () => require("./helpers/clerkMock")());

const { createHarness, SECRET } = require("./helpers/reviewsHarness");

const QUESTION = "Why did my blink all-in fail against the roach defence?";

describe("reviews: opt-in replay file sharing", () => {
  let h;
  let prepareDownload;

  const post = (name, body) => request(h.app).post("/v1/reviews").set("authorization", h.bearer(name)).send(body);
  const download = (id, name) => {
    const req = request(h.app).get(`/v1/reviews/${id}/replay`);
    return name ? req.set("authorization", h.bearer(name)) : req;
  };
  const share = (id, name, value) =>
    request(h.app).post(`/v1/reviews/${id}/replay-sharing`).set("authorization", h.bearer(name)).send({ value });

  beforeAll(async () => {
    h = await createHarness({ admins: ["mod"] });
    await h.seedUser("asker", { displayName: "BlinkMaster" });
    await h.seedUser("reviewer", { displayName: "ReviewFox" });
    await h.seedUser("mod");
    prepareDownload = jest.fn(async (_userId, _gameId, opts) => ({
      url: "https://replays.example.com/signed",
      filename: opts?.filename ?? "should-not-be-used.SC2Replay",
      expiresIn: 300,
    }));
    h.services.reviews.replayFiles = { prepareDownload };
  });
  afterAll(async () => {
    await h.close();
  });
  beforeEach(() => prepareDownload.mockClear());

  async function seedStoredGame(gameId) {
    const id = await h.seedGame("asker", { gameId });
    await h.db.games.updateOne(
      { userId: h.userId("asker"), gameId: id },
      { $set: { replayFile: { storedAt: new Date(), sizeBytes: 12345 } } },
    );
    return id;
  }

  test("off by default: nothing to download", async () => {
    const gameId = await seedStoredGame("share-default");
    const id = (await post("asker", { gameId, question: QUESTION })).body.id;
    const page = await request(h.app).get(`/v1/reviews/${id}`);
    expect(page.body.request.replay).toEqual({ shared: false, available: false });
    expect((await request(h.app).get("/v1/reviews?sort=new")).body.items.find((c) => c.id === id).replayShared).toBe(false);
    const res = await download(id, "reviewer");
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("replay_not_shared");
    expect(prepareDownload).not.toHaveBeenCalled();
    await request(h.app).post(`/v1/reviews/${id}/close`).set("authorization", h.bearer("asker")).expect(200);
  });

  test("shared by the asker: signed-in players get a neutral-named signed link", async () => {
    const gameId = await seedStoredGame("share-on");
    const id = (await post("asker", { gameId, question: QUESTION, shareReplay: true })).body.id;

    const page = await request(h.app).get(`/v1/reviews/${id}`);
    expect(page.body.request.replay).toEqual({ shared: true, available: true });
    expect((await request(h.app).get("/v1/reviews?sort=new")).body.items.find((c) => c.id === id).replayShared).toBe(true);

    expect((await download(id, null)).status).toBe(401);
    const res = await download(id, "reviewer");
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toContain("no-store");
    expect(res.body).toEqual({ url: "https://replays.example.com/signed", filename: `sc2tools-review-${id}.SC2Replay`, expiresIn: 300 });
    // The owner's stored file, under a name that never includes the opponent.
    expect(prepareDownload).toHaveBeenCalledWith(h.userId("asker"), gameId, { filename: `sc2tools-review-${id}.SC2Replay` });
    expect(JSON.stringify(res.body)).not.toContain(SECRET.name);
    await request(h.app).post(`/v1/reviews/${id}/close`).set("authorization", h.bearer("asker")).expect(200);
  });

  test("the asker can stop sharing (and restart); nobody else can turn it on", async () => {
    const gameId = await seedStoredGame("share-toggle");
    const id = (await post("asker", { gameId, question: QUESTION, shareReplay: true })).body.id;
    expect((await share(id, "reviewer", true)).status).toBe(403);
    expect((await share(id, "asker", false)).body).toEqual({ shared: false, optedIn: false });
    expect((await download(id, "reviewer")).body.error.code).toBe("replay_not_shared");
    expect((await share(id, "asker", true)).body).toEqual({ shared: true, optedIn: true });
    expect((await download(id, "reviewer")).status).toBe(200);
    // A moderator may switch it off, not on.
    expect((await share(id, "mod", false)).status).toBe(200);
    expect((await share(id, "mod", true)).status).toBe(403);
    await request(h.app).post(`/v1/reviews/${id}/close`).set("authorization", h.bearer("asker")).expect(200);
  });

  test("while hidden, downloads pause but the asker still sees and controls their choice", async () => {
    await h.seedUser("asker3", { displayName: "ThirdAsker" });
    const gameId = await h.seedGame("asker3", { gameId: "share-hidden" });
    await h.db.games.updateOne({ userId: h.userId("asker3"), gameId }, { $set: { replayFile: { storedAt: new Date() } } });
    const id = (await post("asker3", { gameId, question: QUESTION, shareReplay: true })).body.id;
    // Auto-hidden by reports: nobody can download…
    await h.db.reviewRequests.updateOne({ _id: id }, { $set: { hidden: true } });
    expect((await download(id, "reviewer")).status).toBe(404);
    // …the asker sees their saved choice (on, paused) and can switch it off.
    const askerView = await request(h.app).get(`/v1/reviews/${id}`).set("authorization", h.bearer("asker3"));
    expect(askerView.body.request.replay).toEqual({ shared: false, available: false, optedIn: true });
    expect((await share(id, "asker3", false)).body).toEqual({ shared: false, optedIn: false });
    // A moderator restoring the request doesn't turn sharing back on.
    await h.services.reviews.moderationTargets().review_request.restore(id);
    expect((await download(id, "reviewer")).body.error.code).toBe("replay_not_shared");
    // Other viewers never see the asker's saved choice.
    expect((await request(h.app).get(`/v1/reviews/${id}`)).body.request.replay).toEqual({ shared: false, available: false });
  });

  test("board cards only offer a download when the file is actually stored", async () => {
    await h.seedUser("asker4", { displayName: "FourthAsker" });
    const stored = await h.seedGame("asker4", { gameId: "card-stored" });
    await h.db.games.updateOne({ userId: h.userId("asker4"), gameId: stored }, { $set: { replayFile: { storedAt: new Date() } } });
    const missing = await h.seedGame("asker4", { gameId: "card-missing" });
    const withFile = (await post("asker4", { gameId: stored, question: QUESTION, shareReplay: true })).body.id;
    const noFile = (await post("asker4", { gameId: missing, question: QUESTION, shareReplay: true })).body.id;
    const cards = (await request(h.app).get("/v1/reviews?sort=new")).body.items;
    expect(cards.find((c) => c.id === withFile).replayShared).toBe(true);
    expect(cards.find((c) => c.id === noFile).replayShared).toBe(false);
  });

  test("shared but not uploaded yet, closed, or hidden: no link", async () => {
    // A second asker: the first already used today's 3 requests.
    await h.seedUser("asker2", { displayName: "SecondAsker" });
    const gameId = await h.seedGame("asker2", { gameId: "share-no-file" });
    const id = (await post("asker2", { gameId, question: QUESTION, shareReplay: true })).body.id;
    expect((await request(h.app).get(`/v1/reviews/${id}`)).body.request.replay).toEqual({ shared: true, available: false });

    prepareDownload.mockRejectedValueOnce(Object.assign(new Error("replay_unavailable"), { status: 404 }));
    const missing = await download(id, "reviewer");
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe("replay_unavailable");

    await h.db.reviewRequests.updateOne({ _id: id }, { $set: { hidden: true } });
    expect((await download(id, "reviewer")).status).toBe(404);
    await h.db.reviewRequests.updateOne({ _id: id }, { $set: { hidden: false } });

    await request(h.app).post(`/v1/reviews/${id}/close`).set("authorization", h.bearer("asker2")).expect(200);
    expect((await download(id, "reviewer")).status).toBe(410);
    expect((await request(h.app).get(`/v1/reviews/${id}`)).body.request.replay).toEqual({ shared: false, available: false });
    expect((await share(id, "asker2", true)).status).toBe(409);
  });
});
