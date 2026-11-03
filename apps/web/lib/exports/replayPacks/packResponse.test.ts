// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { readPackBytes } from "./packReaders";
import { parsePackResponse, readPackResponse } from "./packResponse";
import { StoreZip } from "./zipStore";
import { bytesResponse, deferred, encode, envelope, heldResponse, jsonResponse, readyRow, ticks } from "./replayPackTestFixtures";

const scope = (signal = new AbortController().signal) => ({ signal, assertCurrent: () => {} });
describe("closed C03 replay response and actual original bytes", () => {
  it("accepts the exact ordered seven-field rows and fixed failures, without an invented digest or owner", async () => {
    const rows = [readyRow("one"), { gameId: "two", status: "unavailable", code: "replay_unavailable" }, { gameId: "three", status: "retryable", code: "replay_download_expired" }];
    const parsed = await readPackResponse(jsonResponse(envelope(rows)), ["one", "two", "three"], scope());
    expect(parsed).toEqual(rows); expect(Object.isFrozen(parsed)).toBe(true); expect(Object.isFrozen(parsed[0])).toBe(true);
  });

  it.each([
    (value: ReturnType<typeof envelope>) => ({ ...value, owner: "private" }),
    (value: ReturnType<typeof envelope>) => ({ ...value, version: 2 }),
    (value: ReturnType<typeof envelope>) => ({ ...value, counts: { ...value.counts, available: 0 } }),
    (value: ReturnType<typeof envelope>) => ({ ...value, items: [readyRow("other")] }),
    (value: ReturnType<typeof envelope>) => ({ ...value, items: [readyRow("one", { digest: "invented" })] }),
    (value: ReturnType<typeof envelope>) => ({ ...value, items: [readyRow("one", { sizeBytes: 5 * 1024 ** 2 + 1 })] }),
    (value: ReturnType<typeof envelope>) => ({ ...value, items: [readyRow("one", { sizeBytes: 3 })] }),
    (value: ReturnType<typeof envelope>) => ({ ...value, items: [readyRow("one", { expiresAt: "2026-11-03T06:02:00.000Z" })] }),
    (value: ReturnType<typeof envelope>) => ({ ...value, items: [readyRow("one", { issuedAt: "2026-11-03T06:00:00.001Z" })] }),
    (value: ReturnType<typeof envelope>) => ({ ...value, items: [readyRow("one", { url: "https://user:password@private.example/file" })] }),
    (value: ReturnType<typeof envelope>) => ({ ...value, items: [readyRow("one", { filename: "../private" })] }),
    (value: ReturnType<typeof envelope>) => ({ ...value, items: [{ gameId: "one", status: "unavailable", code: "unknown" }] }),
  ])("rejects malformed closed schema %# before any URL can be used", mutate => {
    expect(() => parsePackResponse(mutate(envelope([readyRow("one")])), ["one"])).toThrow("unreadable export");
  });

  it("rejects reordered, duplicate and extra IDs and non-JSON/fatal UTF8/oversized response bodies", async () => {
    expect(() => parsePackResponse(envelope([readyRow("two"), readyRow("one")]), ["one", "two"])).toThrow();
    expect(() => parsePackResponse(envelope([readyRow("one"), readyRow("one")]), ["one", "one"])).toThrow();
    expect(() => parsePackResponse(envelope([readyRow("one"), readyRow("two")]), ["one"])).toThrow();
    await expect(readPackResponse(bytesResponse(encode("{}")), ["one"], scope())).rejects.toMatchObject({ code: "invalid" });
    await expect(readPackResponse(bytesResponse(new Uint8Array([0xff]), 200, { "content-type": "application/json" }), ["one"], scope())).rejects.toMatchObject({ code: "invalid" });
    await expect(readPackResponse(bytesResponse(new Uint8Array(1024 ** 2 + 1)), ["one"], scope())).rejects.toMatchObject({ code: "invalid" });
  });

  it.each([206, 204, 403, 429, 500])("requires actual HTTP200, rejecting %s even with four bytes", async status => {
    await expect(readPackBytes(bytesResponse(undefined, status), scope(), 5 * 1024 ** 2, 4)).rejects.toMatchObject({ code: "failed" });
  });

  it("uses exact EOF bytes, ignoring missing/lying Content-Length, and enforces the published 5MiB cap", async () => {
    expect(parsePackResponse(envelope([readyRow("one", { sizeBytes: 5 * 1024 ** 2 })]), ["one"])[0]).toMatchObject({ sizeBytes: 5 * 1024 ** 2 });
    expect(await readPackBytes(bytesResponse(), scope(), 5 * 1024 ** 2, 4)).toEqual(new Uint8Array([1, 2, 3, 4]));
    await expect(readPackBytes(bytesResponse(new Uint8Array(3), 200, { "content-length": "4" }), scope(), 5 * 1024 ** 2, 4)).rejects.toMatchObject({ code: "incomplete" });
    await expect(readPackBytes(bytesResponse(new Uint8Array(5), 200, { "content-length": "4" }), scope(), 5 * 1024 ** 2, 4)).rejects.toMatchObject({ code: "invalid" });
    await expect(readPackBytes(bytesResponse(new Uint8Array(5 * 1024 ** 2 + 1)), scope(), 5 * 1024 ** 2)).rejects.toMatchObject({ code: "invalid" });
    const zip = new StoreZip(async () => {});
    await expect(zip.add("fixed.SC2Replay", new Uint8Array(5 * 1024 ** 2 + 1), "replay")).rejects.toThrow();
  });

  it("rejects truncated JSON even with HTTP200 and a complete-looking Content-Length", async () => {
    const bytes = encode(JSON.stringify(envelope([readyRow("one")])).slice(0, -2));
    await expect(readPackResponse(bytesResponse(bytes, 200, { "content-type": "application/json", "content-length": "500" }), ["one"], scope())).rejects.toMatchObject({ code: "invalid" });
  });

  it("joins actual held read and cancellation independently, with one cancel and lock release", async () => {
    const held = heldResponse(), controller = new AbortController(), done = deferred();
    const work = readPackBytes(held.response, scope(controller.signal), 5 * 1024 ** 2, 4);
    const observed = work.then(() => "success", error => error); void observed.then(() => done.resolve());
    let settled = false; void done.promise.then(() => { settled = true; });
    try {
      await held.entered.promise; controller.abort(); await vi.waitFor(() => expect(held.reader.cancel).toHaveBeenCalledOnce());
      held.cancelled.resolve(); await ticks(); expect(settled).toBe(false); expect(held.reader.releaseLock).not.toHaveBeenCalled();
      held.read.resolve({ done: true, value: undefined }); expect(await observed).toMatchObject({ code: "cancelled" });
      expect(held.reader.releaseLock).toHaveBeenCalledOnce(); expect(held.reader.cancel).toHaveBeenCalledOnce();
    } finally { held.cancelled.resolve(); held.read.resolve({ done: true, value: undefined }); await observed; }
  });
});
