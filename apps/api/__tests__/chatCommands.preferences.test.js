"use strict";
const request = require("supertest");
const { createHarness } = require("./helpers/reviewsHarness");
jest.mock("@clerk/backend", () => require("./helpers/clerkMock")());
/** @type {any} */ let h;
const preference = "/v1/me/preferences/chatCommands";
const get = (who = "owner") => request(h.app).get(preference).set("authorization", h.bearer(who));
const put = (/** @type {Record<string,any>} */ body, who = "owner") => request(h.app).put(preference).set("authorization", h.bearer(who)).send(body);
beforeAll(async () => { h = await createHarness(); await h.seedUser("owner"); await h.seedUser("other"); });
afterAll(async () => { await h?.close(); });
beforeEach(async () => { await h.db.users.updateMany({}, { $unset: { "preferences.chatCommands": "" } }); });

test("private owner settings retain unrelated preferences and return normalized safe values", async () => {
  await h.db.users.updateOne({ userId: "u_owner" }, { $set: { "preferences.misc": { volume: 0.5 } } });
  const saved = await put({ builtins: [{ id: "record", trigger: "score", cooldownSec: 30 }], custom: [{ trigger: "hello", response: "Hi {user}; {record}" }] });
  expect(saved.status).toBe(200); expect(saved.headers["cache-control"]).toBe("private, no-store");
  const owned = await get(); expect(owned.body).toEqual(saved.body); expect(owned.headers["cache-control"]).toBe("private, no-store");
  expect((await get("other")).body).toEqual({ builtins: [], custom: [] });
  expect((await h.db.users.findOne({ userId: "u_owner" })).preferences.misc).toEqual({ volume: 0.5 });
});

test("invalid writes return400 and preserve the last valid command settings", async () => {
  const first = await put({ custom: [{ trigger: "hello", response: "Safe" }] }); expect(first.status).toBe(200);
  for (const body of [{ custom: [{ trigger: "hello", response: "<b>Unsafe</b>" }] }, { custom: [{ trigger: "hello", response: "{secret}" }] },
    { custom: [{ trigger: "rank", response: "Reserved" }] }, { builtins: [{ id: "record", enabled: "false" }] }]) {
    const response = await put(body); expect(response.status).toBe(400); expect(response.body.error.code).toBe("invalid_chat_commands");
    expect((await get()).body).toEqual(first.body);
  }
});

test("owner preview uses a selected existing token and never bypasses another owner's credential", async () => {
  const own = await h.services.overlayTokens.create("u_owner", "Local test");
  const other = await h.services.overlayTokens.create("u_other", "Other local test");
  const saved = await put({ custom: [{ trigger: "hello", response: "Hi {user}" }] }); expect(saved.status).toBe(200);
  const preview = (/** @type {string} */ token) => request(h.app).post("/v1/me/chat-commands/try").set("authorization", h.bearer("owner")).send({ token, command: "hello", user: "Viewer" });
  const exact = await preview(own.token); expect(exact.status).toBe(200); expect(exact.body.text).toBe("Hi Viewer");
  expect((await preview(other.token)).status).toBe(404);
  const live = await request(h.app).get(`/v1/chatbot/${own.token}/hello?user=Viewer`);
  expect(live.status).toBe(200); expect(live.text).toBe(exact.body.text);
});

test("corrupt legacy fields cannot expose unrelated stored secrets", async () => {
  await h.db.users.updateOne({ userId: "u_owner" }, { $set: { "preferences.chatCommands": { token: "stored-secret", custom: [{ trigger: "bad", response: "<b>bad</b>" }] } } });
  const response = await get(); expect(response.status).toBe(200); expect(response.body).toEqual({ builtins: [], custom: [] });
  expect(response.text).not.toContain("stored-secret");
});
