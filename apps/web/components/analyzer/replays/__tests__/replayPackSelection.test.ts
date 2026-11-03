// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { matchingReplayQuery, packSelectionRow, parseMatchingReplays, selectMatchingReplays } from "../replayPackSelection";
import { bytesResponse, deferred, encode, heldResponse, jsonResponse, ticks } from "@/lib/exports/replayPacks/replayPackTestFixtures";

const scope = (controller = new AbortController()) => ({ signal: controller.signal, assertCurrent: () => {}, token: vi.fn(async (): Promise<string | null> => "synthetic") });
describe("bounded matching replay selection", () => {
  it("uses one existing first100 current-sort query without a cursor and copies only bounded recorded metadata", async () => {
    const query = "sort=date_asc&search=Player&since=2026-08-01&regions=NA&cursor=private&limit=25&enrich=all";
    const params = new URLSearchParams(matchingReplayQuery(query)); expect(params.get("sort")).toBe("date_asc"); expect(params.get("search")).toBe("Player");
    expect(params.get("limit")).toBe("100"); expect(params.get("enrich")).toBe("none"); expect(params.has("cursor")).toBe(false);
    const fetch = vi.fn(async () => jsonResponse({ items: [{ gameId: " one ", date: "2026-11-03", result: "Victory", map: "Map", matchup: "PvT", opponent: { displayName: "Other", pulseId: "PRIVATE_ID" },
      replaySizeBytes: 12, url: "PRIVATE_URL", token: "PRIVATE_TOKEN", objectKey: "PRIVATE_PATH" }], page: { hasMore: true, nextCursor: "private" } }));
    const rows = await selectMatchingReplays("https://api.example.test", query, scope(), fetch);
    expect(fetch).toHaveBeenCalledOnce(); expect(fetch.mock.calls[0]).toHaveLength(2);
    expect(rows).toEqual([{ gameId: "one", date: "2026-11-03", result: "Win", map: "Map", matchup: "PvT", opponent: "Other", replaySizeBytes: 12 }]);
    expect(Object.isFrozen(rows)).toBe(true); expect(Object.isFrozen(rows[0])).toBe(true); expect(JSON.stringify(rows)).not.toContain("PRIVATE_");
    expect(parseMatchingReplays({ items: [] })).toEqual([]);
  });

  it("rejects raw101 before deduplication, duplicate/URL/invalid IDs and malformed payloads without truncating", () => {
    for (const items of [Array.from({ length: 101 }, (_, index) => ({ gameId: `id-${index}` })), Array.from({ length: 101 }, () => ({ gameId: "same" })), [{ gameId: "one" }, { gameId: " one " }],
      [{ gameId: "https://private.example" }], [{ gameId: "bad\ud800" }], [{ gameId: "a\n" }]]) expect(() => parseMatchingReplays({ items })).toThrow();
    expect(() => parseMatchingReplays({})).toThrow(); expect(() => parseMatchingReplays({ items: "one" })).toThrow();
    const rows = parseMatchingReplays({ items: Array.from({ length: 100 }, (_, index) => ({ gameId: `id-${index}` })) }); expect(rows).toHaveLength(100);
    expect(packSelectionRow({ gameId: "one", result: "PRIVATE_TOKEN", replaySizeBytes: 5 * 1024 ** 2 + 1, map: "ｈｔｔｐｓ：／／PRIVATE_URL", opponent: { displayName: "Bearer PRIVATE" } }))
      .toMatchObject({ result: "Unknown", replaySizeBytes: null, map: "", opponent: "" });
  });

  it("rejects non200/fatalUTF8/truncated/over1MiB bodies with fixed errors, never raw transport text", async () => {
    const replies = [jsonResponse({ items: [] }, 206), bytesResponse(new Uint8Array([0xff]), 200, { "content-type": "application/json" }),
      bytesResponse(encode('{"items":['), 200, { "content-type": "application/json" }), bytesResponse(new Uint8Array(1024 ** 2 + 1), 200, { "content-type": "application/json" })];
    for (const reply of replies) await expect(selectMatchingReplays("https://api.example.test", "", scope(), vi.fn(async () => reply))).rejects.toBeInstanceOf(Error);
    await expect(selectMatchingReplays("https://api.example.test", "", scope(), vi.fn(async () => { throw new Error("PRIVATE_SIGNED_URL"); }))).rejects.toMatchObject({ message: "The server returned an unreadable export. Please try again." });
  });

  it("holds actual read and cancel separately and starts no fetch after a held JWT retires", async () => {
    const body = heldResponse(), controller = new AbortController(), current = scope(controller);
    let settled = false; const work = selectMatchingReplays("https://api.example.test", "", current, vi.fn(async () => body.response));
    const observed = work.then(() => { settled = true; return null; }, error => { settled = true; return error; });
    try {
      await vi.waitFor(() => expect(body.reader.read).toHaveBeenCalledOnce()); controller.abort(); await vi.waitFor(() => expect(body.reader.cancel).toHaveBeenCalledOnce());
      body.cancelled.resolve(); await ticks(); expect(settled).toBe(false); body.read.resolve({ done: true, value: undefined }); expect(await observed).toMatchObject({ code: "cancelled" });
    } finally { body.cancelled.resolve(); body.read.resolve({ done: true, value: undefined }); await observed; }
    const token = deferred<string | null>(), retired = new AbortController(), owned = scope(retired), fetch = vi.fn(); owned.token.mockImplementation(() => token.promise);
    const pending = selectMatchingReplays("https://api.example.test", "", owned, fetch), result = pending.catch(error => error);
    retired.abort(); token.resolve("old"); expect(await result).toMatchObject({ code: "cancelled" }); expect(fetch).not.toHaveBeenCalled();
  });
});
