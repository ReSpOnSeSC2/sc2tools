// @ts-nocheck
"use strict";
const { randomBytes } = require("crypto");
const { createBackupStore } = require("./helpers/userBackupsStore");
const { PART_BYTES } = require("../src/services/userBackupsStore");

describe("private streamed backup transport", () => {
  test("multipart gzip round-trips past the part boundary without a whole input body", async () => {
    const store = createBackupStore();
    const rows = Array.from({ length: 18 }, () => randomBytes(1024 * 1024).toString("base64"));
    async function* input() { for (const row of rows) yield `${row}\n`; }
    const answer = await store.put("user/one", "bk_streamed", input());
    const parts = store.calls.filter((call) => call.name === "UploadPartCommand");
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.slice(0, -1).every((part) => part.input.ContentLength === PART_BYTES)).toBe(true);
    expect(answer.sizeBytes).toBe(store.objects.get("user-backups/user%2Fone/bk_streamed.ndjson.gz").length);
    const output = []; for await (const row of store.read("user/one", "bk_streamed")) output.push(row);
    expect(output).toEqual(rows);
    expect(store.calls[0].input).toMatchObject({ ContentType: "application/gzip", Metadata: { format: "ndjson-gzip-v1" } });
    expect(store.calls[0].input.ContentEncoding).toBeUndefined();
  });
  test("a source failure aborts the upload and never publishes a partial archive", async () => {
    const store = createBackupStore();
    async function* broken() { yield "first\n"; throw new Error("cursor failed"); }
    await expect(store.put("u", "bk_failed", broken())).rejects.toThrow("cursor failed");
    expect(store.uploads.size).toBe(0); expect(store.objects.size).toBe(0);
    expect(store.calls.some((call) => call.name === "AbortMultipartUploadCommand")).toBe(true);
  });
  test("download is a short private grant; account purge only touches its encoded prefix", async () => {
    const store = createBackupStore();
    store.objects.set("user-backups/a/bk_one.ndjson.gz", Buffer.from("a"));
    store.objects.set("user-backups/ab/bk_other.ndjson.gz", Buffer.from("b"));
    expect(await store.download("a", "bk_one")).toEqual({ url: "https://private.fixture/user-backups/a/bk_one.ndjson.gz?signed=1", expiresIn: 60 });
    await store.deleteAllForUser("a"); expect([...store.objects.keys()]).toEqual(["user-backups/ab/bk_other.ndjson.gz"]);
    expect(() => store.keyFor("a", "../b")).toThrow("invalid_backup_identity");
  });
});
