// @ts-nocheck
"use strict";

const { MongoClient } = require("mongodb");
const { MongoMemoryServer } = require("mongodb-memory-server");
const { cleanupSupportEmail, parseArguments } = require("../scripts/cleanup-support-email");
const { AdminEventsService } = require("../src/services/adminEvents");
const { supportEmailMailboxId, supportEmailStateId } = require("../src/services/supportEmailScope");

const CONFIG = { mailbox: "responsecoaching@gmail.com", labelName: "SC2Tools Support" };
const LABEL = { id: "Label_support", name: CONFIG.labelName, type: "user" };
function event(id, payload = {}, extra = {}) {
  return {
    eventId: id, type: "user_message", readAt: null,
    payload: { source: "email", mailbox: CONFIG.mailbox, gmailMessageId: id,
      email: `${id}@example.com`, subject: `${id} subject`, message: "PRIVATE BODY NEVER PROJECTED", ...payload },
    ...extra,
  };
}
function gmailClient(respond = () => undefined) {
  return {
    accessToken: jest.fn(async () => "readonly-token"),
    getJson: jest.fn(async (raw, token) => {
      expect(token).toBe("readonly-token");
      const url = new URL(raw);
      const result = await respond(url);
      if (result !== undefined) return result;
      if (url.pathname.endsWith("/profile")) return { emailAddress: CONFIG.mailbox };
      if (url.pathname.endsWith("/labels")) return { labels: [LABEL] };
      if (url.pathname.endsWith("/messages")) {
        expect(url.searchParams.get("labelIds")).toBe(LABEL.id);
        expect(url.searchParams.get("includeSpamTrash")).toBe("true");
        return { messages: [{ id: "approved" }] };
      }
      expect(url.searchParams.get("format")).toBe("minimal");
      return { id: url.pathname.split("/").pop(), labelIds: [] };
    }),
  };
}

describe("operator support-email cleanup", () => {
  let mongo;
  let client;
  let adminEvents;
  let supportEmailSync;
  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    client = await new MongoClient(mongo.getUri()).connect();
    adminEvents = client.db("support_email_cleanup").collection("admin_events");
    supportEmailSync = client.db("support_email_cleanup").collection("support_email_sync");
  });
  afterAll(async () => { await client?.close(); await mongo?.stop(); });
  beforeEach(async () => { await adminEvents.deleteMany({}); await supportEmailSync.deleteMany({}); });
  afterEach(() => { jest.restoreAllMocks(); });

  test("defaults to a header-only preview and preserves every original row", async () => {
    await adminEvents.insertMany([
      event("unrelated"), event("approved"), event("website", { source: "website" }),
      event("other-mailbox", { mailbox: "other@gmail.com" }),
      event("signup", {}, { type: "user_signup" }), event("download", {}, { type: "agent_download" }),
      event("invalid", { gmailMessageId: null }),
    ]);
    const find = jest.spyOn(adminEvents, "find");
    const gmail = gmailClient();
    const result = await cleanupSupportEmail({ adminEvents, gmail, config: CONFIG });
    expect(result).toEqual({ preview: [{ gmailMessageId: "unrelated", from: "unrelated@example.com", subject: "unrelated subject" }],
      deletedCount: 0, newlyApproved: 0, invalidReferences: 1 });
    expect(await adminEvents.countDocuments({})).toBe(7);
    expect(find.mock.calls[0]).toEqual([
      { type: "user_message", "payload.source": "email", "payload.mailbox": CONFIG.mailbox },
      { projection: { _id: 1, "payload.gmailMessageId": 1, "payload.email": 1, "payload.subject": 1 } },
    ]);
    expect(JSON.stringify(result)).not.toContain("PRIVATE BODY");
    expect(gmail.getJson.mock.calls.every(([url]) => !/format=full|modify|trash|batchDelete/.test(url))).toBe(true);
  });

  test("apply deletes only scoped imported copies after reading every approved-ID page", async () => {
    await adminEvents.insertMany([
      event("unrelated"), event("approved"), event("second-approved"),
      event("website", { source: "website" }), event("other", { mailbox: "other@gmail.com" }),
      event("signup", {}, { type: "user_signup" }), event("download", {}, { type: "agent_download" }),
    ]);
    const gmail = gmailClient((url) => {
      if (!url.pathname.endsWith("/messages")) return;
      return url.searchParams.get("pageToken") === "page2"
        ? { messages: [{ id: "second-approved" }] }
        : { messages: [{ id: "approved" }], nextPageToken: "page2" };
    });
    const result = await cleanupSupportEmail({ adminEvents, gmail, config: CONFIG, apply: true });
    expect(result.deletedCount).toBe(1);
    expect(await adminEvents.findOne({ eventId: "unrelated" })).toBeNull();
    expect(await adminEvents.countDocuments({})).toBe(6);
    expect(gmail.getJson.mock.calls.filter(([url]) => url.includes("/unrelated?"))).toHaveLength(2);
  });

  test.each(["mailbox", "label"])("fails closed when the live %s is not approved", async (failure) => {
    await adminEvents.insertOne(event("unrelated"));
    const gmail = gmailClient((url) => {
      if (failure === "mailbox" && url.pathname.endsWith("/profile")) return { emailAddress: "wrong@gmail.com" };
      if (failure === "label" && url.pathname.endsWith("/labels")) return { labels: [{ ...LABEL, name: "Other label" }] };
    });
    const find = jest.spyOn(adminEvents, "find");
    await expect(cleanupSupportEmail({ adminEvents, gmail, config: CONFIG, apply: true }))
      .rejects.toMatchObject({ code: failure === "mailbox" ? "mailbox_mismatch" : "gmail_label_missing" });
    expect(find).not.toHaveBeenCalled();
    expect(await adminEvents.countDocuments({})).toBe(1);
  });

  test("a later-page Gmail failure cannot delete any copied messages", async () => {
    await adminEvents.insertOne(event("unrelated"));
    const gmail = gmailClient((url) => {
      if (!url.pathname.endsWith("/messages")) return;
      if (url.searchParams.has("pageToken")) throw Object.assign(new Error("private provider response"), { code: "gmail_http_503" });
      return { messages: [{ id: "approved" }], nextPageToken: "page2" };
    });
    await expect(cleanupSupportEmail({ adminEvents, gmail, config: CONFIG, apply: true })).rejects.toMatchObject({ code: "gmail_http_503" });
    expect(await adminEvents.countDocuments({})).toBe(1);
  });

  test("all candidate metadata is validated before the first delete", async () => {
    await adminEvents.insertMany([event("first"), event("second")]);
    const gmail = gmailClient((url) => {
      if (url.pathname.endsWith("/second")) throw Object.assign(new Error("private"), { code: "gmail_http_403" });
    });
    const remove = jest.spyOn(adminEvents, "deleteOne");
    await expect(cleanupSupportEmail({ adminEvents, gmail, config: CONFIG, apply: true })).rejects.toMatchObject({ code: "gmail_http_403" });
    expect(remove).not.toHaveBeenCalled();
    expect(await adminEvents.countDocuments({})).toBe(2);
  });

  test("preserves mail labeled after the list snapshot or immediately before deletion", async () => {
    await adminEvents.insertMany([event("newly-approved"), event("approved-before-delete")]);
    let secondChecks = 0;
    const gmail = gmailClient((url) => {
      if (url.pathname.endsWith("/newly-approved")) return { id: "newly-approved", labelIds: [LABEL.id] };
      if (url.pathname.endsWith("/approved-before-delete")) {
        secondChecks += 1;
        return { id: "approved-before-delete", labelIds: secondChecks === 1 ? [] : [LABEL.id] };
      }
    });
    const result = await cleanupSupportEmail({ adminEvents, gmail, config: CONFIG, apply: true });
    expect(result.preview.map((row) => row.gmailMessageId)).toEqual(["approved-before-delete"]);
    expect(result.newlyApproved).toBe(1);
    expect(result.deletedCount).toBe(0);
    expect(await adminEvents.countDocuments({})).toBe(2);
  });

  test("a renamed or recreated approval label aborts apply", async () => {
    await adminEvents.insertOne(event("unrelated"));
    let checks = 0;
    const gmail = gmailClient((url) => {
      if (url.pathname.endsWith("/labels")) return { labels: [{ ...LABEL, id: ++checks === 1 ? LABEL.id : "Label_recreated" }] };
    });
    await expect(cleanupSupportEmail({ adminEvents, gmail, config: CONFIG, apply: true })).rejects.toMatchObject({ code: "gmail_label_changed" });
    expect(await adminEvents.countDocuments({})).toBe(1);
  });

  test("status reads only the current labeled checkpoint, never the legacy broad importer state", async () => {
    const now = new Date();
    await supportEmailSync.insertMany([
      { _id: supportEmailMailboxId(CONFIG.mailbox), lastSuccessAt: now },
      { _id: supportEmailStateId(CONFIG.mailbox, "Other Label"), lastSuccessAt: now },
      { _id: supportEmailStateId(CONFIG.mailbox, CONFIG.labelName), lastAttemptAt: now, lastErrorCode: "gmail_label_missing" },
    ]);
    const service = new AdminEventsService({ db: { supportEmailSync }, supportEmail: CONFIG });
    expect(await service.supportEmailStatus()).toEqual({ configured: true, labelName: CONFIG.labelName,
      lastAttemptAt: now.toISOString(), lastSuccessAt: null, errorCode: "gmail_label_missing" });
  });
});

test("destructive cleanup requires the exact --apply flag", () => {
  expect(parseArguments([])).toEqual({ apply: false, help: false });
  expect(parseArguments(["--dry-run"])).toEqual({ apply: false, help: false });
  expect(parseArguments(["--apply"])).toEqual({ apply: true, help: false });
  expect(() => parseArguments(["--apply", "--dry-run"])).toThrow("invalid_arguments");
  expect(() => parseArguments(["--force"])).toThrow("invalid_arguments");
});
