import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import {
  SAVE_KEY_PREFIX, SaveUploader, TokenCache, localProgress, planMerge, pullSaves, readLocalSaves, saveTime, slotOf, writeIfNewer,
} from "../saveSync";

class MemoryStorage implements Storage {
  private readonly items = new Map<string, string>();
  get length() { return this.items.size; }
  clear() { this.items.clear(); }
  getItem(key: string) { return this.items.get(key) ?? null; }
  key(index: number) { return [...this.items.keys()][index] ?? null; }
  removeItem(key: string) { this.items.delete(key); }
  setItem(key: string, value: string) { this.items.set(key, String(value)); }
}

const save = (when: number, chapter = 1) => JSON.stringify({ fmt: "humdingers-save", v: 3, meta: { when, chapter, playtime: 60 }, state: {} });
const key = (slot: string) => SAVE_KEY_PREFIX + slot;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("Humdingers save sync rules", () => {
  it("reads only Humdingers save slots", () => {
    expect(slotOf("humdingers.save.0")).toBe("0");
    expect(slotOf("humdingers.save.auto")).toBe("auto");
    for (const other of ["humdingers.audio", "humdingers.save.Bad", "humdingers.save.", "sc2tools.theme", null]) expect(slotOf(other)).toBeNull();
    const storage = new MemoryStorage();
    storage.setItem(key("0"), save(1));
    storage.setItem("humdingers.audio", "{}");
    expect([...readLocalSaves(storage).keys()]).toEqual(["0"]);
  });

  it("takes a save's time from its own metadata", () => {
    expect(saveTime(save(5))).toBe(5);
    for (const bad of ["{}", "nope", JSON.stringify({ fmt: "other", meta: { when: 5 } }), save(0), null]) expect(saveTime(bad)).toBeNull();
  });

  it("lets the newer save win per slot and keeps the local copy on a tie", () => {
    const local = new Map([["0", save(200)], ["1", save(100)], ["2", save(300)], ["auto", "corrupt"]]);
    const cloud = [
      { slot: "0", data: save(100), when: 100 }, { slot: "1", data: save(150), when: 150 }, { slot: "2", data: save(300), when: 300 },
      { slot: "3", data: save(50), when: 50 }, { slot: "BAD", data: save(999), when: 999 }, { slot: "4", data: "corrupt", when: 9 },
    ];
    const plan = planMerge(local, cloud);
    expect(plan.upload).toEqual([{ slot: "0", data: save(200) }]);
    expect(plan.writeLocal.map((entry) => entry.slot)).toEqual(["1", "3"]);
  });

  it("never overwrites a newer local save with a late download", () => {
    const storage = new MemoryStorage();
    storage.setItem(key("0"), save(500));
    expect(writeIfNewer(storage, { slot: "0", data: save(400), when: 400 })).toBe(false);
    expect(writeIfNewer(storage, { slot: "0", data: save(500), when: 500 })).toBe(false);
    expect(writeIfNewer(storage, { slot: "0", data: save(600), when: 600 })).toBe(true);
    expect(storage.getItem(key("0"))).toBe(save(600));
  });

  it("reports the furthest chapter and whether anything is saved", () => {
    const storage = new MemoryStorage();
    expect(localProgress(storage)).toEqual({ chapter: 0, saved: false });
    storage.setItem(key("0"), save(1, 2));
    storage.setItem(key("auto"), save(2, 4));
    storage.setItem(key("1"), "corrupt");
    expect(localProgress(storage)).toEqual({ chapter: 4, saved: true });
  });
});

describe("Humdingers save transfer", () => {
  let fetchMock: Mock;
  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
  const tokens = () => new TokenCache(async () => "token-1");
  const call = (index: number) => fetchMock.mock.calls[index] as [string, RequestInit & { headers: Record<string, string> }];

  it("brings newer account saves in before play and returns the ones the account lacks", async () => {
    const storage = new MemoryStorage();
    storage.setItem(key("0"), save(100));
    storage.setItem(key("1"), save(900));
    fetchMock.mockResolvedValue(json({ saves: [{ slot: "0", data: save(200), when: 200 }] }));
    expect(await pullSaves(tokens(), storage)).toEqual([{ slot: "1", data: save(900) }]);
    expect(storage.getItem(key("0"))).toBe(save(200));
    expect(call(0)[0]).toMatch(/\/v1\/me\/humdingers\/saves$/);
    expect(call(0)[1].headers.authorization).toBe("Bearer token-1");
  });

  it("uploads a slot shortly after the game saves and writes back a newer account copy", async () => {
    const storage = new MemoryStorage();
    storage.setItem(key("0"), save(600));
    const uploader = new SaveUploader(tokens(), storage, 2_000);
    fetchMock.mockResolvedValueOnce(json({ error: { code: "newer_save" }, save: { slot: "0", data: save(700), when: 700 } }, 409));
    uploader.queue("0", save(600));
    await vi.advanceTimersByTimeAsync(1_999);
    expect(fetchMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(call(0)[0]).toMatch(/\/v1\/me\/humdingers\/saves\/0$/);
    expect(call(0)[1].method).toBe("PUT");
    expect(JSON.parse(String(call(0)[1].body))).toEqual({ data: save(600) });
    expect(storage.getItem(key("0"))).toBe(save(700));
  });

  it("deletes a removed slot and retries after a server error", async () => {
    const uploader = new SaveUploader(tokens(), new MemoryStorage(), 2_000);
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 503 })).mockResolvedValueOnce(json({ deleted: true }));
    uploader.queue("auto", null);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(call(0)[1].method).toBe("DELETE");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(call(1)[1].method).toBe("DELETE");
    uploader.dispose();
  });

  it("sends pending saves at page exit with keepalive and the cached token, without waiting", async () => {
    const cache = tokens();
    await cache.get();
    const uploader = new SaveUploader(cache, new MemoryStorage(), 2_000);
    fetchMock.mockResolvedValue(json({ save: { slot: "0" } }));
    uploader.queue("0", save(1));
    uploader.flushOnExit();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(call(0)[1].keepalive).toBe(true);
    expect(call(0)[1].headers.authorization).toBe("Bearer token-1");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
