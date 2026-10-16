// @ts-nocheck
"use strict";

const { MongoMemoryServer } = require("mongodb-memory-server");
const pino = require("pino");
const { connect } = require("../src/db/connect");
const { AdminEventsService } = require("../src/services/adminEvents");
const { SupportEmailService, buildSupportEmailJob, messagePayload } = require("../src/services/supportEmail");
const { parseSupportEmailConfig } = require("../src/config/loader");
const { supportEmailMailboxId, supportEmailStateId } = require("../src/services/supportEmailScope");

const NOW = Date.parse("2026-10-16T12:00:00Z");
const LABEL_ID = "Label_support";
const CONFIG = {
  mailbox: "responsecoaching@gmail.com", clientId: "client-id",
  clientSecret: "client-secret", refreshToken: "refresh-secret",
  startAfter: "2026-09-01T00:00:00Z", intervalMs: 60000, labelName: "SC2Tools Support",
};
const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { "content-type": "application/json" },
});
const part = (mimeType, text) => ({ mimeType, body: { data: Buffer.from(text).toString("base64url") } });
function mail(id, overrides = {}) {
  return {
    id, internalDate: String(NOW - 100000), labelIds: [LABEL_ID],
    payload: {
      ...part("text/plain", "The overlay identifies me as the opponent."),
      headers: [{ name: "From", value: "Reporter <reporter@example.com>" },
        { name: "Subject", value: "Live Overlay bug" }],
    },
    ...overrides,
  };
}

describe("support Gmail delivery", () => {
  let mongo;
  let db;
  let events;
  let emit;
  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    db = await connect({ uri: mongo.getUri(), dbName: "support_email_test" });
  });
  afterAll(async () => {
    await db?.close();
    await mongo?.stop();
  });
  beforeEach(async () => {
    await db.adminEvents.deleteMany({});
    await db.supportEmailSync.deleteMany({});
    emit = jest.fn();
    events = new AdminEventsService({ db, io: { to: () => ({ emit }) }, supportEmail: CONFIG });
  });
  function service(responder, now = () => NOW,
    labels = [{ id: LABEL_ID, name: CONFIG.labelName, type: "user" }]) {
    const fetchImpl = jest.fn(async (url, options) => {
      if (url === "https://oauth2.googleapis.com/token") {
        expect(options.method).toBe("POST");
        expect(options.body.get("grant_type")).toBe("refresh_token");
        return json({ access_token: "read-token" });
      }
      expect(options.method).toBeUndefined(); // Gmail requests are read-only GETs.
      expect(options.headers.authorization).toBe("Bearer read-token");
      if (url.endsWith("/profile")) return json({ emailAddress: CONFIG.mailbox });
      if (url.endsWith("/labels")) return json({ labels });
      return responder(new URL(url), options);
    });
    return { fetchImpl, worker: new SupportEmailService({ db, adminEvents: events, config: CONFIG, fetchImpl, now }) };
  }

  test("already-read archived email enters Messages unread and broadcasts only once across restarts", async () => {
    const responder = (url) => url.pathname.endsWith("/messages")
      ? json({ messages: [{ id: "abc123" }] }) : json(mail("abc123"));
    const first = service(responder);
    await first.worker.sync();
    expect(await db.supportEmailSync.findOne({})).toMatchObject({ _schemaVersion: 1 });
    await service(responder).worker.sync();
    const rows = await events.list({ type: "user_message" });
    expect(rows.items).toHaveLength(1);
    expect(rows.items[0]).toMatchObject({
      type: "user_message", readAt: null,
      payload: { source: "email", email: "reporter@example.com", userId: null,
        subject: "Live Overlay bug", mailbox: CONFIG.mailbox,
        gmailMessageId: "abc123", receivedAt: new Date(NOW - 100000).toISOString() },
    });
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit.mock.calls[0][0]).toBe("admin:event");
    const counts = await events.counts();
    expect(counts.unreadCount).toBe(1);
    expect(counts.supportEmail).toMatchObject({ configured: true, lastSuccessAt: new Date(NOW).toISOString(), errorCode: null });
    const listCall = first.fetchImpl.mock.calls.find(([url]) => new URL(url).searchParams.has("q"));
    const query = new URL(listCall[0]).searchParams.get("q");
    expect(new URL(listCall[0]).searchParams.get("labelIds")).toBe(LABEL_ID);
    expect(query).toContain("-in:sent -in:drafts -in:chats");
    expect(query).not.toMatch(/is:unread|in:inbox/);
  });

  test("missing exact support label fails closed without listing messages", async () => {
    const responder = jest.fn();
    const { worker, fetchImpl } = service(responder, () => NOW, [
      { id: "Label_similar", name: "sc2tools support", type: "user" },
    ]);
    const logger = { warn: jest.fn(), info: jest.fn() };
    expect(await buildSupportEmailJob({ service: worker, logger }).runOnce()).toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(3); // token, profile, labels only
    expect(responder).not.toHaveBeenCalled();
    expect(await db.adminEvents.countDocuments({})).toBe(0);
    expect(await events.supportEmailStatus()).toMatchObject({ errorCode: "gmail_label_missing" });
  });

  test("unlabeled mail returned by a stale label listing is never recorded", async () => {
    const { worker } = service((url) => url.pathname.endsWith("/messages")
      ? json({ messages: [{ id: "removed" }, { id: "approved" }] })
      : json(mail(url.pathname.split("/").pop(), {
        labelIds: url.pathname.endsWith("/removed") ? [] : [LABEL_ID],
      })));
    await worker.sync();
    const saved = await db.adminEvents.find({ type: "user_message" }).toArray();
    expect(saved).toHaveLength(1);
    expect(saved[0].payload.gmailMessageId).toBe("approved");
  });

  test("a label API failure cannot trigger an unrestricted mailbox listing", async () => {
    const responder = jest.fn();
    const { worker, fetchImpl } = service(responder);
    fetchImpl.mockImplementation(async (url) => {
      if (url.endsWith("/token")) return json({ access_token: "read-token" });
      if (url.endsWith("/profile")) return json({ emailAddress: CONFIG.mailbox });
      if (url.endsWith("/labels")) return json({ error: "permission denied" }, 403);
      return responder(url);
    });
    await expect(worker.sync()).rejects.toMatchObject({ code: "gmail_http_403" });
    expect(responder).not.toHaveBeenCalled();
    expect(await db.adminEvents.countDocuments({})).toBe(0);
  });

  test("every label scan retains the historical cutoff for newly labeled older mail", async () => {
    const queries = [];
    let includeOld = false;
    const responder = (url) => {
      if (url.pathname.endsWith("/messages")) {
        queries.push(url.searchParams.get("q"));
        return json({ messages: [{ id: "recent" }, ...(includeOld ? [{ id: "newly_labeled_old" }] : [])] });
      }
      const id = url.pathname.split("/").pop();
      return json(mail(id, { internalDate: String(id === "recent" ? NOW - 100000 : NOW - 10 * 86400000) }));
    };
    await service(responder).worker.sync();
    includeOld = true;
    await service(responder, () => NOW + 86400000).worker.sync();
    expect(await db.adminEvents.countDocuments({})).toBe(2);
    const after = `after:${Math.floor(Date.parse(CONFIG.startAfter) / 1000) - 1}`;
    expect(queries).toHaveLength(2);
    expect(queries.every((query) => query.includes(after))).toBe(true);
    expect((await db.supportEmailSync.findOne({})).afterSec).toBe(Date.parse(CONFIG.startAfter) / 1000);
  });

  test("mailbox-wide ingestion keys survive label-scoped checkpoint migration", async () => {
    const mailboxId = supportEmailMailboxId(CONFIG.mailbox);
    await db.supportEmailSync.insertOne({ _id: mailboxId,
      afterSec: NOW / 1000 - 300, revision: 20, lastSuccessAt: new Date(NOW - 60000) });
    await events.record("user_message", messagePayload(mail("existing"), CONFIG.mailbox),
      { ingestionKey: `gmail:${mailboxId}:existing` });
    const responder = (url) => url.pathname.endsWith("/messages")
      ? json({ messages: [{ id: "existing" }, { id: "approved_old" }] })
      : json(mail(url.pathname.split("/").pop(), { internalDate: String(NOW - 10 * 86400000) }));
    const { worker, fetchImpl } = service(responder);
    await worker.sync();
    expect(await db.adminEvents.countDocuments({})).toBe(2);
    expect(fetchImpl.mock.calls.some(([url]) => url.includes("/messages/existing?"))).toBe(false);
    expect(await db.supportEmailSync.findOne({ _id: supportEmailStateId(CONFIG.mailbox, CONFIG.labelName) }))
      .toMatchObject({ afterSec: Date.parse(CONFIG.startAfter) / 1000, lastSuccessAt: new Date(NOW) });
    expect((await db.supportEmailSync.findOne({ _id: mailboxId })).revision).toBe(20);
  });

  test("a mid-page failure retries unsaved mail without duplicating prior messages", async () => {
    let fail = true;
    const { worker } = service((url) => {
      if (url.pathname.endsWith("/messages")) return json({ messages: [{ id: "first" }, { id: "second" }] });
      if (url.pathname.endsWith("/second") && fail) return json({ error: "private provider body" }, 503);
      return json(mail(url.pathname.split("/").pop()));
    });
    await expect(worker.sync()).rejects.toMatchObject({ code: "gmail_http_503" });
    expect(await db.adminEvents.countDocuments({})).toBe(1);
    expect((await db.supportEmailSync.findOne({})).lastSuccessAt).toBeUndefined();
    fail = false;
    await worker.sync();
    expect(await db.adminEvents.countDocuments({})).toBe(2);
    expect(emit).toHaveBeenCalledTimes(2);
  });

  test("a failed Mongo message save cannot advance the delivery checkpoint", async () => {
    const { worker } = service((url) => url.pathname.endsWith("/messages")
      ? json({ messages: [{ id: "abc123" }] }) : json(mail("abc123")));
    const save = jest.spyOn(events, "record").mockResolvedValueOnce(null);
    await expect(worker.sync()).rejects.toMatchObject({ code: "message_not_saved" });
    expect((await db.supportEmailSync.findOne({})).revision).toBe(0);
    save.mockRestore();
    await worker.sync();
    expect(await db.adminEvents.countDocuments({})).toBe(1);
  });

  test("large backfills persist page tokens and keep the window fixed after restart", async () => {
    const queries = [];
    const responder = (url) => {
      if (!url.pathname.endsWith("/messages")) return json(mail(url.pathname.split("/").pop()));
      queries.push(url.searchParams);
      const page = Number(url.searchParams.get("pageToken") || "0");
      return json({ messages: [{ id: `mail${page}` }], ...(page < 5 ? { nextPageToken: String(page + 1) } : {}) });
    };
    await service(responder).worker.sync();
    expect(await db.adminEvents.countDocuments({})).toBe(5);
    expect((await db.supportEmailSync.findOne({})).pageToken).toBe("5");
    await service(responder, () => NOW + 60000).worker.sync();
    expect(await db.adminEvents.countDocuments({})).toBe(6);
    expect(queries[5].get("pageToken")).toBe("5");
    expect(queries[5].get("q")).toBe(queries[0].get("q"));
    expect((await db.supportEmailSync.findOne({})).pageToken).toBeNull();
  });

  test("the database deduplicates simultaneous deliveries while preserving read state", async () => {
    const payload = messagePayload(mail("same"), CONFIG.mailbox);
    const saved = await Promise.all([
      events.record("user_message", payload, { ingestionKey: "gmail:one:same" }),
      events.record("user_message", payload, { ingestionKey: "gmail:one:same" }),
    ]);
    expect(saved[0].eventId).toBe(saved[1].eventId);
    await events.markAllRead();
    const replay = await events.record("user_message", payload, { ingestionKey: "gmail:one:same" });
    expect(replay.readAt).toBeInstanceOf(Date);
    expect(emit).toHaveBeenCalledTimes(1);
  });

  test("mailbox mismatch fails closed and the admin status exposes the safe error", async () => {
    const logger = { warn: jest.fn(), info: jest.fn() };
    const fetchImpl = jest.fn(async (url) => url.endsWith("/token")
      ? json({ access_token: "private-token" }) : json({ emailAddress: "different@gmail.com" }));
    const worker = new SupportEmailService({ db, adminEvents: events, config: CONFIG, fetchImpl, now: () => NOW });
    const job = buildSupportEmailJob({ service: worker, logger });
    expect(await job.runOnce()).toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(await db.adminEvents.countDocuments({})).toBe(0);
    expect(await events.supportEmailStatus()).toMatchObject({ configured: true, errorCode: "mailbox_mismatch" });
    expect(logger.warn.mock.calls).toEqual([[{ code: "mailbox_mismatch" }, "support_email_sync_failed"]]);
  });

  test("unconfigured intake stays visible and never accesses Gmail", async () => {
    const disabled = new AdminEventsService({ db });
    expect(await disabled.supportEmailStatus()).toEqual({ configured: false, labelName: null,
      lastSuccessAt: null, lastAttemptAt: null, errorCode: null });
    const job = buildSupportEmailJob({ service: null, logger: pino({ level: "silent" }) });
    job.start();
    expect(await job.runOnce()).toBeNull();
    await job.stop();
  });
});

test("HTML-only body and attachment names are plain text, bounded, with original timestamp", () => {
  const payload = messagePayload(mail("html", {
    payload: { mimeType: "multipart/mixed", parts: [
      part("text/html", "<style>.x{color:red}</style><p>Overlay &amp; player</p><br>Wrong identity"),
      { filename: "screenshot.png", mimeType: "image/png", body: { attachmentId: "not-downloaded" } },
    ] },
  }), CONFIG.mailbox);
  expect(payload.message).toContain("Overlay & player\n\nWrong identity");
  expect(payload.message).toContain("Attachments: screenshot.png");
  expect(payload.message).not.toContain("color:red");
  const long = messagePayload(mail("long", { payload: part("text/plain", "x".repeat(5000)) }), CONFIG.mailbox);
  expect(long.message.length).toBe(4000);
  expect(long.message).toContain("open the original email");
});

describe("support Gmail configuration", () => {
  const env = { SUPPORT_GMAIL_CLIENT_ID: "id", SUPPORT_GMAIL_CLIENT_SECRET: "secret",
    SUPPORT_GMAIL_REFRESH_TOKEN: "refresh", SUPPORT_GMAIL_START_AFTER: "2026-09-01T00:00:00-04:00" };
  test("disabled by default; full config requires an explicit timezone cutoff", () => {
    expect(parseSupportEmailConfig({})).toBeNull();
    expect(parseSupportEmailConfig(env)).toMatchObject({ mailbox: CONFIG.mailbox, intervalMs: 60000, labelName: CONFIG.labelName });
    expect(() => parseSupportEmailConfig({ SUPPORT_GMAIL_REFRESH_TOKEN: "alone" })).toThrow(/SUPPORT_GMAIL_CLIENT_ID/);
    expect(() => parseSupportEmailConfig({ ...env, SUPPORT_GMAIL_START_AFTER: "2026-09-01" })).toThrow(/timestamp/);
    expect(parseSupportEmailConfig({ ...env, SUPPORT_GMAIL_INTERVAL_SEC: "1" }).intervalMs).toBe(60000);
  });
});
